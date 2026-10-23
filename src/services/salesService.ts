import { enqueueOutboxInTx, runTransaction, STORES } from '../db/indexedDb';
import {
  DuplicateOperationError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import {
  createId,
  nextDailyReceiptNumber,
  toLocalDateKey,
} from '../domain/ids';
import { multiplyMoneyByQty } from '../domain/money';
import {
  CreditTransaction,
  Product,
  Sale,
  SaleItem,
  SalePaymentMethod,
  SaleWithItems,
  StockMovement,
} from '../domain/types';

export interface CartLineInput {
  productId: string;
  quantity: number;
}

export interface RecordSaleInput {
  /** Unique client request ID generated when preparing checkout; prevents double-tap duplicates */
  operationId: string;
  items: CartLineInput[];
  paymentMethod: SalePaymentMethod;
  /** Required when paymentMethod === 'credit' */
  customerId?: string | null;
  /** Optional manual note for Mobile Money (e.g. "Airtel Money", "MTN MoMo") */
  paymentReference?: string | null;
  note?: string;
  now?: Date;
}

/**
 * Records a sale, its item snapshots, stock deductions, and (if credit) customer
 * credit ledger charge inside ONE atomic IndexedDB transaction.
 *
 * Guarantees:
 * - Prevents sales exceeding available stock (aborts entire transaction on shortage).
 * - Prevents duplicate submissions if the user double-taps Confirm Sale.
 * - Preserves product name, selling price, and cost price at the exact time of sale.
 */
export async function recordSale(input: RecordSaleInput): Promise<SaleWithItems> {
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new ValidationError('Missing operation ID for sale.');
  }

  if (!['cash', 'mobile_money', 'credit'].includes(input.paymentMethod)) {
    throw new ValidationError('Please choose a valid payment method.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError('Add at least one product to the cart before confirming a sale.');
  }

  // Combine quantities if the same productId was passed more than once
  const mergedQtyByProduct = new Map<string, number>();
  for (const line of input.items) {
    if (!line.productId) {
      throw new ValidationError('Invalid product in cart.');
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError('Each cart item quantity must be a whole number greater than 0.');
    }
    mergedQtyByProduct.set(
      line.productId,
      (mergedQtyByProduct.get(line.productId) ?? 0) + line.quantity
    );
  }

  if (input.paymentMethod === 'credit' && !input.customerId) {
    throw new ValidationError('Select a customer to record a credit sale.');
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const localDate = toLocalDateKey(now);

  return runTransaction(
    [
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
      STORES.syncOutbox,
    ],
    'readwrite',
    async (ctx) => {
      // 1. Guard against accidental double-tap / duplicate submission
      const existingSale = await ctx.getOneByIndex(
        STORES.sales,
        'by_operationId',
        operationId
      );
      if (existingSale) {
        throw new DuplicateOperationError(
          operationId,
          `Sale ${existingSale.receiptNumber} was already recorded.`
        );
      }

      // 2. Validate customer when recording a credit sale
      let customerNameSnapshot: string | null = null;
      let customerIsDemo = false;
      const customerId =
        input.paymentMethod === 'credit' ? (input.customerId ?? null) : null;
      if (customerId) {
        const customer = await ctx.get(STORES.customers, customerId);
        if (!customer) {
          throw new NotFoundError('Selected customer could not be found.');
        }
        customerNameSnapshot = customer.name;
        customerIsDemo = Boolean(customer.isDemo);
      }

      // 3. Load and verify every product's stock BEFORE mutating anything
      const verifiedLines: Array<{ product: Product; quantity: number }> = [];
      for (const [productId, quantity] of mergedQtyByProduct.entries()) {
        const product = await ctx.get(STORES.products, productId);
        if (!product) {
          throw new NotFoundError('One of the products in the cart no longer exists.');
        }
        if (product.isArchived) {
          throw new ValidationError(
            `"${product.name}" has been archived and cannot be sold unless restored.`
          );
        }
        if (product.stockQty < quantity) {
          throw new InsufficientStockError(
            product.id,
            product.name,
            product.stockQty,
            quantity
          );
        }
        verifiedLines.push({ product, quantity });
      }

      const isDemoSale =
        customerIsDemo ||
        verifiedLines.some((line) => Boolean(line.product.isDemo));

      // 4. Determine collision-safe receipt sequence for today
      const todaysSales = await ctx.getAllByIndex(
        STORES.sales,
        'by_localDate',
        localDate
      );
      const receiptNumber = nextDailyReceiptNumber(
        localDate,
        todaysSales.map((s) => s.receiptNumber)
      );
      const saleId = createId('sal');

      // 5. Build SaleItems snapshots, deduct stock, and log StockMovements
      const saleItems: SaleItem[] = [];
      const createdMovements: StockMovement[] = [];
      let totalNgwee = 0;
      let totalUnits = 0;
      let knownCostTotalNgwee = 0;
      let knownCostRevenueNgwee = 0;
      let missingCostLineCount = 0;
      let missingCostRevenueNgwee = 0;

      for (const { product, quantity } of verifiedLines) {
        const lineTotalNgwee = multiplyMoneyByQty(
          product.sellingPriceNgwee,
          quantity
        );
        totalNgwee += lineTotalNgwee;
        totalUnits += quantity;

        if (product.costPriceNgwee !== null) {
          knownCostTotalNgwee += product.costPriceNgwee * quantity;
          knownCostRevenueNgwee += lineTotalNgwee;
        } else {
          missingCostLineCount += 1;
          missingCostRevenueNgwee += lineTotalNgwee;
        }

        const saleItem: SaleItem = {
          id: createId('sli'),
          saleId,
          productId: product.id,
          productNameAtSale: product.name,
          unitLabelAtSale: product.unitLabel,
          sellingPriceAtSaleNgwee: product.sellingPriceNgwee,
          costPriceAtSaleNgwee: product.costPriceNgwee,
          quantity,
          lineTotalNgwee,
          ...(isDemoSale ? { isDemo: true } : {}),
          createdAt: nowIso,
        };
        saleItems.push(saleItem);

        const newStockQty = product.stockQty - quantity;
        const updatedProduct: Product = {
          ...product,
          stockQty: newStockQty,
          updatedAt: nowIso,
        };

        const stockMovement: StockMovement = {
          id: createId('stk'),
          operationId: `${operationId}_stk_${product.id}`,
          productId: product.id,
          productNameSnapshot: product.name,
          type: 'sale',
          deltaQty: -quantity,
          previousQty: product.stockQty,
          newQty: newStockQty,
          reason: `Sale ${receiptNumber}`,
          relatedSaleId: saleId,
          ...(isDemoSale ? { isDemo: true } : {}),
          createdAt: nowIso,
        };
        createdMovements.push(stockMovement);

        await ctx.put(STORES.products, updatedProduct);
        await ctx.add(STORES.stockMovements, stockMovement);
      }

      // 6. Save Sale & SaleItems
      const paymentReference =
        input.paymentMethod === 'mobile_money'
          ? (input.paymentReference ?? '').trim().slice(0, 80) || null
          : null;

      const sale: Sale = {
        id: saleId,
        operationId,
        receiptNumber,
        paymentMethod: input.paymentMethod,
        paymentReference,
        customerId,
        customerNameSnapshot,
        totalNgwee,
        totalUnits,
        knownCostTotalNgwee,
        knownCostRevenueNgwee,
        missingCostLineCount,
        missingCostRevenueNgwee,
        note: (input.note ?? '').trim().slice(0, 200),
        ...(isDemoSale ? { isDemo: true } : {}),
        createdAt: nowIso,
        localDate,
      };

      await ctx.add(STORES.sales, sale);
      for (const item of saleItems) {
        await ctx.add(STORES.saleItems, item);
      }

      // 7. If Credit sale, record customer debt transaction in the same atomic transaction
      let createdCreditTx: CreditTransaction | null = null;
      if (input.paymentMethod === 'credit' && customerId && customerNameSnapshot) {
        const itemsSummary = saleItems
          .map((i) => `${i.quantity}x ${i.productNameAtSale}`)
          .join(', ')
          .slice(0, 160);

        createdCreditTx = {
          id: createId('crd'),
          operationId: `${operationId}_credit`,
          customerId,
          customerNameSnapshot,
          type: 'credit_sale',
          amountNgwee: totalNgwee,
          paymentMethod: null,
          relatedSaleId: sale.id,
          note: `Sale ${receiptNumber}: ${itemsSummary}`,
          ...(isDemoSale ? { isDemo: true } : {}),
          createdAt: nowIso,
          localDate,
        };
        await ctx.add(STORES.creditTransactions, createdCreditTx);
      }

      // 8. Enqueue real shop sale atomically into syncOutbox (never sync demo data)
      if (!isDemoSale) {
        await enqueueOutboxInTx(ctx, {
          operationId,
          opType: 'sale.record',
          createdAt: nowIso,
          payload: {
            sale,
            saleItems,
            stockMovements: createdMovements,
            creditTransaction: createdCreditTx,
          },
        });
      }

      return {
        ...sale,
        items: saleItems,
      };
    }
  );
}

/**
 * Lists sales (newest first) together with their preserved SaleItem snapshots.
 */
export async function listSalesWithItems(options: {
  localDate?: string;
  limit?: number;
} = {}): Promise<SaleWithItems[]> {
  return runTransaction([STORES.sales, STORES.saleItems], 'readonly', async (ctx) => {
    const sales = options.localDate
      ? await ctx.getAllByIndex(STORES.sales, 'by_localDate', options.localDate)
      : await ctx.getAll(STORES.sales);

    const allItems = await ctx.getAll(STORES.saleItems);
    const itemsBySaleId = new Map<string, SaleItem[]>();
    for (const item of allItems) {
      const list = itemsBySaleId.get(item.saleId);
      if (list) {
        list.push(item);
      } else {
        itemsBySaleId.set(item.saleId, [item]);
      }
    }

    const sorted = sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sliced = options.limit ? sorted.slice(0, options.limit) : sorted;

    return sliced.map((sale) => ({
      ...sale,
      items: itemsBySaleId.get(sale.id) ?? [],
    }));
  });
}
