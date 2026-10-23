import { enqueueOutboxInTx, runTransaction, STORES } from '../db/indexedDb';
import { ValidationError } from '../domain/errors';
import { createId, toLocalDateKey } from '../domain/ids';
import {
  CreditTransaction,
  Customer,
  Product,
  Sale,
  SaleItem,
  ShopSettings,
  StockMovement,
} from '../domain/types';

const DEFAULT_SHOP_NAME = 'My Shop';

function makeDefaultSettings(nowIso = new Date().toISOString()): ShopSettings {
  return {
    key: 'shopSettings',
    shopName: DEFAULT_SHOP_NAME,
    hasDemoData: false,
    lastBackupAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Reads (or initializes) local shop settings.
 */
export async function getShopSettings(): Promise<ShopSettings> {
  return runTransaction([STORES.meta], 'readwrite', async (ctx) => {
    const existing = await ctx.get(STORES.meta, 'shopSettings');
    if (existing) {
      return existing;
    }
    const created = makeDefaultSettings();
    await ctx.put(STORES.meta, created);
    return created;
  });
}

/**
 * Updates the shop's display name.
 */
export async function updateShopName(rawName: string): Promise<ShopSettings> {
  const shopName = rawName.trim().replace(/\s+/g, ' ');
  if (!shopName) {
    throw new ValidationError('Shop name cannot be blank.');
  }
  if (shopName.length > 80) {
    throw new ValidationError('Shop name must be 80 characters or fewer.');
  }
  const nowIso = new Date().toISOString();

  return runTransaction(
    [STORES.meta, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const current =
        (await ctx.get(STORES.meta, 'shopSettings')) ??
        makeDefaultSettings(nowIso);
      const updated: ShopSettings = {
        ...current,
        shopName,
        updatedAt: nowIso,
      };
      await ctx.put(STORES.meta, updated);
      await enqueueOutboxInTx(ctx, {
        operationId: createId('op'),
        opType: 'shop.update_name',
        createdAt: nowIso,
        payload: {
          shopName,
          updatedAt: nowIso,
        },
      });
      return updated;
    }
  );
}

/**
 * Loads clearly marked [DEMO] Zambian kiosk sample data ONLY when requested by the user.
 * All demo records carry `isDemo: true` and can be removed in one tap via `removeDemoData()`.
 */
export async function loadSampleDemoData(now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const localDate = toLocalDateKey(now);

  await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
    ],
    'readwrite',
    async (ctx) => {
      const existingProducts = await ctx.getAll(STORES.products);
      if (existingProducts.some((p) => p.isDemo)) {
        throw new ValidationError('Sample demo data is already loaded.');
      }

      const demoProductsData: Array<{
        name: string;
        unitLabel: string;
        sellingPriceNgwee: number;
        costPriceNgwee: number | null;
        stockQty: number;
        lowStockThreshold: number;
      }> = [
        {
          name: '[DEMO] Roller Meal 25kg',
          unitLabel: '25kg bag',
          sellingPriceNgwee: 28500, // K285.00
          costPriceNgwee: 25500, // K255.00
          stockQty: 8,
          lowStockThreshold: 5,
        },
        {
          name: '[DEMO] Cooking Oil 2L',
          unitLabel: '2L bottle',
          sellingPriceNgwee: 9200, // K92.00
          costPriceNgwee: 7800, // K78.00
          stockQty: 4, // Low stock example
          lowStockThreshold: 5,
        },
        {
          name: '[DEMO] White Sugar 2kg',
          unitLabel: '2kg pack',
          sellingPriceNgwee: 6800, // K68.00
          costPriceNgwee: 5900, // K59.00
          stockQty: 14,
          lowStockThreshold: 5,
        },
        {
          name: '[DEMO] White Bread Loaf',
          unitLabel: 'loaf',
          sellingPriceNgwee: 2250, // K22.50
          costPriceNgwee: 1850, // K18.50
          stockQty: 11,
          lowStockThreshold: 5,
        },
        {
          name: '[DEMO] Bath Soap Tablet',
          unitLabel: '175g bar',
          sellingPriceNgwee: 1850, // K18.50
          costPriceNgwee: 1400, // K14.00
          stockQty: 3, // Low stock example
          lowStockThreshold: 5,
        },
        {
          name: '[DEMO] Talktime Voucher K10',
          unitLabel: 'voucher',
          sellingPriceNgwee: 1000, // K10.00
          costPriceNgwee: null, // Demonstrates missing cost price transparency
          stockQty: 20,
          lowStockThreshold: 5,
        },
      ];

      const createdProducts: Product[] = [];
      for (const item of demoProductsData) {
        const product: Product = {
          id: createId('prd'),
          name: item.name,
          unitLabel: item.unitLabel,
          sellingPriceNgwee: item.sellingPriceNgwee,
          costPriceNgwee: item.costPriceNgwee,
          stockQty: item.stockQty,
          lowStockThreshold: item.lowStockThreshold,
          isArchived: false,
          isDemo: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        createdProducts.push(product);
        await ctx.add(STORES.products, product);

        const move: StockMovement = {
          id: createId('stk'),
          operationId: createId('op'),
          productId: product.id,
          productNameSnapshot: product.name,
          type: 'initial',
          deltaQty: product.stockQty,
          previousQty: 0,
          newQty: product.stockQty,
          reason: '[DEMO] Opening sample stock',
          relatedSaleId: null,
          isDemo: true,
          createdAt: nowIso,
        };
        await ctx.add(STORES.stockMovements, move);
      }

      // Demo customer with a sample credit sale + partial repayment
      const demoCustomer: Customer = {
        id: createId('cus'),
        name: '[DEMO] Mama Mwansa',
        phone: '0977000111',
        notes: 'Sample credit customer — safe to remove anytime',
        isDemo: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await ctx.add(STORES.customers, demoCustomer);

      const compactDate = localDate.replace(/-/g, '');

      // Demo Sale 1: Cash sale (2x White Bread Loaf = K45.00)
      const bread = createdProducts[3];
      const sale1Id = createId('sal');
      const sale1: Sale = {
        id: sale1Id,
        operationId: createId('op'),
        receiptNumber: `DEMO-${compactDate}-001`,
        paymentMethod: 'cash',
        paymentReference: null,
        customerId: null,
        customerNameSnapshot: null,
        totalNgwee: bread.sellingPriceNgwee * 2,
        totalUnits: 2,
        knownCostTotalNgwee: (bread.costPriceNgwee ?? 0) * 2,
        knownCostRevenueNgwee: bread.sellingPriceNgwee * 2,
        missingCostLineCount: 0,
        missingCostRevenueNgwee: 0,
        note: '[DEMO] Sample cash sale',
        isDemo: true,
        createdAt: nowIso,
        localDate,
      };
      const sale1Item: SaleItem = {
        id: createId('sli'),
        saleId: sale1Id,
        productId: bread.id,
        productNameAtSale: bread.name,
        unitLabelAtSale: bread.unitLabel,
        sellingPriceAtSaleNgwee: bread.sellingPriceNgwee,
        costPriceAtSaleNgwee: bread.costPriceNgwee,
        quantity: 2,
        lineTotalNgwee: bread.sellingPriceNgwee * 2,
        isDemo: true,
        createdAt: nowIso,
      };
      await ctx.add(STORES.sales, sale1);
      await ctx.add(STORES.saleItems, sale1Item);

      // Demo Sale 2: Credit sale to Mama Mwansa (1x White Sugar 2kg = K68.00)
      const sugar = createdProducts[2];
      const sale2Id = createId('sal');
      const sale2: Sale = {
        id: sale2Id,
        operationId: createId('op'),
        receiptNumber: `DEMO-${compactDate}-002`,
        paymentMethod: 'credit',
        paymentReference: null,
        customerId: demoCustomer.id,
        customerNameSnapshot: demoCustomer.name,
        totalNgwee: sugar.sellingPriceNgwee,
        totalUnits: 1,
        knownCostTotalNgwee: sugar.costPriceNgwee ?? 0,
        knownCostRevenueNgwee: sugar.sellingPriceNgwee,
        missingCostLineCount: 0,
        missingCostRevenueNgwee: 0,
        note: '[DEMO] Sample credit sale',
        isDemo: true,
        createdAt: nowIso,
        localDate,
      };
      const sale2Item: SaleItem = {
        id: createId('sli'),
        saleId: sale2Id,
        productId: sugar.id,
        productNameAtSale: sugar.name,
        unitLabelAtSale: sugar.unitLabel,
        sellingPriceAtSaleNgwee: sugar.sellingPriceNgwee,
        costPriceAtSaleNgwee: sugar.costPriceNgwee,
        quantity: 1,
        lineTotalNgwee: sugar.sellingPriceNgwee,
        isDemo: true,
        createdAt: nowIso,
      };
      await ctx.add(STORES.sales, sale2);
      await ctx.add(STORES.saleItems, sale2Item);

      const creditCharge: CreditTransaction = {
        id: createId('crd'),
        operationId: createId('op'),
        customerId: demoCustomer.id,
        customerNameSnapshot: demoCustomer.name,
        type: 'credit_sale',
        amountNgwee: sugar.sellingPriceNgwee,
        paymentMethod: null,
        relatedSaleId: sale2Id,
        note: `[DEMO] Sale ${sale2.receiptNumber}: 1x ${sugar.name}`,
        isDemo: true,
        createdAt: nowIso,
        localDate,
      };
      const partialRepayIso = new Date(now.getTime() + 60_000).toISOString();
      const partialRepay: CreditTransaction = {
        id: createId('crd'),
        operationId: createId('op'),
        customerId: demoCustomer.id,
        customerNameSnapshot: demoCustomer.name,
        type: 'repayment',
        amountNgwee: 2000, // K20.00 partial repayment leaving K48.00 owing
        paymentMethod: 'cash',
        relatedSaleId: null,
        note: '[DEMO] Sample partial cash repayment',
        isDemo: true,
        createdAt: partialRepayIso,
        localDate,
      };
      await ctx.add(STORES.creditTransactions, creditCharge);
      await ctx.add(STORES.creditTransactions, partialRepay);

      const settings =
        (await ctx.get(STORES.meta, 'shopSettings')) ?? makeDefaultSettings(nowIso);
      await ctx.put(STORES.meta, {
        ...settings,
        hasDemoData: true,
        updatedAt: nowIso,
      });
    }
  );
}

/**
 * Removes all records tagged with `isDemo: true` (and any transactions tied solely to demo entities)
 * while leaving real shop records untouched.
 */
export async function removeDemoData(): Promise<void> {
  const nowIso = new Date().toISOString();

  await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
    ],
    'readwrite',
    async (ctx) => {
      const products = await ctx.getAll(STORES.products);
      const demoProductIds = new Set<string>();
      for (const p of products) {
        if (p.isDemo || p.name.startsWith('[DEMO]')) {
          demoProductIds.add(p.id);
          await ctx.delete(STORES.products, p.id);
        }
      }

      const customers = await ctx.getAll(STORES.customers);
      const demoCustomerIds = new Set<string>();
      for (const c of customers) {
        if (c.isDemo || c.name.startsWith('[DEMO]')) {
          demoCustomerIds.add(c.id);
          await ctx.delete(STORES.customers, c.id);
        }
      }

      const saleItems = await ctx.getAll(STORES.saleItems);
      const demoSaleIds = new Set<string>();
      const deletedItemIds = new Set<string>();
      for (const item of saleItems) {
        if (item.isDemo || demoProductIds.has(item.productId)) {
          demoSaleIds.add(item.saleId);
          deletedItemIds.add(item.id);
          await ctx.delete(STORES.saleItems, item.id);
        }
      }

      const sales = await ctx.getAll(STORES.sales);
      for (const s of sales) {
        if (
          s.isDemo ||
          demoSaleIds.has(s.id) ||
          (s.customerId && demoCustomerIds.has(s.customerId))
        ) {
          demoSaleIds.add(s.id);
          await ctx.delete(STORES.sales, s.id);
        }
      }

      // Clean up any remaining items on deleted demo sales
      for (const item of saleItems) {
        if (demoSaleIds.has(item.saleId) && !deletedItemIds.has(item.id)) {
          await ctx.delete(STORES.saleItems, item.id);
        }
      }

      const movements = await ctx.getAll(STORES.stockMovements);
      for (const m of movements) {
        if (
          m.isDemo ||
          demoProductIds.has(m.productId) ||
          (m.relatedSaleId && demoSaleIds.has(m.relatedSaleId))
        ) {
          await ctx.delete(STORES.stockMovements, m.id);
        }
      }

      const creditTxs = await ctx.getAll(STORES.creditTransactions);
      const survivingByCustomer = new Map<string, CreditTransaction[]>();
      for (const tx of creditTxs) {
        if (
          tx.isDemo ||
          demoCustomerIds.has(tx.customerId) ||
          (tx.relatedSaleId && demoSaleIds.has(tx.relatedSaleId))
        ) {
          await ctx.delete(STORES.creditTransactions, tx.id);
        } else {
          const list = survivingByCustomer.get(tx.customerId);
          if (list) list.push(tx);
          else survivingByCustomer.set(tx.customerId, [tx]);
        }
      }

      // Safety invariant: if a non-demo customer bought a [DEMO] item on credit AND
      // also recorded a test repayment against it, removing the demo credit sale must not
      // leave excess repayments that create a negative balance.
      for (const txs of survivingByCustomer.values()) {
        let totalCredit = 0;
        let totalRepaid = 0;
        const repaymentsNewestFirst = txs
          .filter((t) => t.type === 'repayment')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        for (const t of txs) {
          if (t.type === 'credit_sale') totalCredit += t.amountNgwee;
          else totalRepaid += t.amountNgwee;
        }

        for (const repay of repaymentsNewestFirst) {
          if (totalRepaid <= totalCredit) break;
          const excess = totalRepaid - totalCredit;
          if (repay.amountNgwee <= excess) {
            await ctx.delete(STORES.creditTransactions, repay.id);
            totalRepaid -= repay.amountNgwee;
          } else {
            await ctx.put(STORES.creditTransactions, {
              ...repay,
              amountNgwee: repay.amountNgwee - excess,
            });
            totalRepaid -= excess;
          }
        }
      }

      const settings =
        (await ctx.get(STORES.meta, 'shopSettings')) ?? makeDefaultSettings(nowIso);
      await ctx.put(STORES.meta, {
        ...settings,
        hasDemoData: false,
        updatedAt: nowIso,
      });
    }
  );
}
