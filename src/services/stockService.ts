import { enqueueOutboxInTx, runTransaction, STORES } from '../db/indexedDb';
import {
  DuplicateOperationError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { createId } from '../domain/ids';
import { assertValidNgwee } from '../domain/money';
import { Product, StockAdjustmentMode, StockMovement } from '../domain/types';

export type { StockAdjustmentMode };

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface CreateProductInput {
  operationId?: string;
  name: string;
  unitLabel?: string;
  sellingPriceNgwee: number;
  costPriceNgwee: number | null;
  initialStockQty: number;
  lowStockThreshold?: number;
  now?: Date;
}

export interface UpdateProductInput {
  name: string;
  unitLabel?: string;
  sellingPriceNgwee: number;
  costPriceNgwee: number | null;
  lowStockThreshold: number;
  now?: Date;
}

export interface AdjustStockInput {
  operationId: string;
  productId: string;
  mode: StockAdjustmentMode;
  quantity: number;
  reason?: string;
  now?: Date;
}

function validateWholeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a whole number (0 or more).`);
  }
  if (value > 1_000_000) {
    throw new ValidationError(`${label} is unreasonably large.`);
  }
}

function normalizeProductName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ValidationError('Product name is required.');
  }
  if (name.length > 120) {
    throw new ValidationError('Product name must be 120 characters or fewer.');
  }
  return name;
}

/**
 * Lists products sorted alphabetically by name.
 */
export async function listProducts(
  options: { includeArchived?: boolean } = {}
): Promise<Product[]> {
  const includeArchived = options.includeArchived ?? false;
  const all = await runTransaction([STORES.products], 'readonly', (ctx) =>
    ctx.getAll(STORES.products)
  );
  return all
    .filter((p) => (includeArchived ? true : !p.isArchived))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Creates a new product and records its opening stock movement atomically.
 */
export async function createProduct(input: CreateProductInput): Promise<Product> {
  const name = normalizeProductName(input.name);
  const unitLabel = (input.unitLabel ?? '').trim().slice(0, 40);
  assertValidNgwee(input.sellingPriceNgwee, 'Selling price', false);

  if (input.costPriceNgwee !== null) {
    assertValidNgwee(input.costPriceNgwee, 'Cost price', true);
  }

  validateWholeNonNegative(input.initialStockQty, 'Opening stock quantity');
  const lowStockThreshold =
    input.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  validateWholeNonNegative(lowStockThreshold, 'Low-stock alert threshold');

  const nowIso = (input.now ?? new Date()).toISOString();
  const operationId = input.operationId ?? createId('op');

  return runTransaction(
    [STORES.products, STORES.stockMovements, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const existingMove = await ctx.getOneByIndex(
        STORES.stockMovements,
        'by_operationId',
        operationId
      );
      if (existingMove) {
        throw new DuplicateOperationError(
          operationId,
          'This product submission was already saved.'
        );
      }

      const product: Product = {
        id: createId('prd'),
        name,
        unitLabel,
        sellingPriceNgwee: input.sellingPriceNgwee,
        costPriceNgwee: input.costPriceNgwee,
        stockQty: input.initialStockQty,
        lowStockThreshold,
        isArchived: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const movement: StockMovement = {
        id: createId('stk'),
        operationId,
        productId: product.id,
        productNameSnapshot: product.name,
        type: 'initial',
        deltaQty: input.initialStockQty,
        previousQty: 0,
        newQty: input.initialStockQty,
        reason: 'Opening stock',
        relatedSaleId: null,
        createdAt: nowIso,
      };

      await ctx.add(STORES.products, product);
      await ctx.add(STORES.stockMovements, movement);
      await enqueueOutboxInTx(ctx, {
        operationId,
        opType: 'product.create',
        createdAt: nowIso,
        payload: {
          product,
          initialMovement: movement,
        },
      });
      return product;
    }
  );
}

/**
 * Updates product details (name, unit, selling price, cost price, low-stock threshold).
 * Historical sales are NOT altered because each SaleItem stores snapshots at sale time.
 */
export async function updateProduct(
  productId: string,
  input: UpdateProductInput
): Promise<Product> {
  const name = normalizeProductName(input.name);
  const unitLabel = (input.unitLabel ?? '').trim().slice(0, 40);
  assertValidNgwee(input.sellingPriceNgwee, 'Selling price', false);

  if (input.costPriceNgwee !== null) {
    assertValidNgwee(input.costPriceNgwee, 'Cost price', true);
  }
  validateWholeNonNegative(input.lowStockThreshold, 'Low-stock alert threshold');

  const nowIso = (input.now ?? new Date()).toISOString();

  return runTransaction(
    [STORES.products, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const existing = await ctx.get(STORES.products, productId);
      if (!existing) {
        throw new NotFoundError('Product not found.');
      }

      const updated: Product = {
        ...existing,
        name,
        unitLabel,
        sellingPriceNgwee: input.sellingPriceNgwee,
        costPriceNgwee: input.costPriceNgwee,
        lowStockThreshold: input.lowStockThreshold,
        updatedAt: nowIso,
      };

      await ctx.put(STORES.products, updated);
      if (!existing.isDemo) {
        await enqueueOutboxInTx(ctx, {
          operationId: createId('op'),
          opType: 'product.update',
          createdAt: nowIso,
          payload: {
            productId: updated.id,
            name: updated.name,
            unitLabel: updated.unitLabel,
            sellingPriceNgwee: updated.sellingPriceNgwee,
            costPriceNgwee: updated.costPriceNgwee,
            lowStockThreshold: updated.lowStockThreshold,
            updatedAt: nowIso,
          },
        });
      }
      return updated;
    }
  );
}

/**
 * Archives or restores a product.
 * Archiving hides the product from active selling while preserving all past sale records.
 */
export async function setProductArchived(
  productId: string,
  isArchived: boolean,
  now: Date = new Date()
): Promise<Product> {
  const nowIso = now.toISOString();
  return runTransaction(
    [STORES.products, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const existing = await ctx.get(STORES.products, productId);
      if (!existing) {
        throw new NotFoundError('Product not found.');
      }
      const updated: Product = {
        ...existing,
        isArchived,
        updatedAt: nowIso,
      };
      await ctx.put(STORES.products, updated);
      if (!existing.isDemo) {
        await enqueueOutboxInTx(ctx, {
          operationId: createId('op'),
          opType: 'product.archive',
          createdAt: nowIso,
          payload: {
            productId: updated.id,
            isArchived,
            updatedAt: nowIso,
          },
        });
      }
      return updated;
    }
  );
}

/**
 * Adjusts stock for a product atomically and writes an audit StockMovement record.
 * Never permits negative stock.
 */
export async function adjustProductStock(
  input: AdjustStockInput
): Promise<{ product: Product; movement: StockMovement }> {
  if (!input.operationId.trim()) {
    throw new ValidationError('Missing operation ID for stock adjustment.');
  }

  if (input.mode === 'set') {
    validateWholeNonNegative(input.quantity, 'New stock count');
  } else {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('Adjustment quantity must be a whole number greater than 0.');
    }
    if (input.quantity > 1_000_000) {
      throw new ValidationError('Adjustment quantity is unreasonably large.');
    }
  }

  const nowIso = (input.now ?? new Date()).toISOString();

  return runTransaction(
    [STORES.products, STORES.stockMovements, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const duplicate = await ctx.getOneByIndex(
        STORES.stockMovements,
        'by_operationId',
        input.operationId
      );
      if (duplicate) {
        throw new DuplicateOperationError(
          input.operationId,
          'This stock adjustment has already been recorded.'
        );
      }

      const product = await ctx.get(STORES.products, input.productId);
      if (!product) {
        throw new NotFoundError('Product not found.');
      }

      const previousQty = product.stockQty;
      let newQty = previousQty;
      let defaultReason = 'Stock adjustment';

      if (input.mode === 'add') {
        newQty = previousQty + input.quantity;
        defaultReason = 'Restocked';
      } else if (input.mode === 'subtract') {
        if (input.quantity > previousQty) {
          throw new ValidationError(
            `Cannot remove ${input.quantity} from "${product.name}" because only ${previousQty} in stock.`
          );
        }
        newQty = previousQty - input.quantity;
        defaultReason = 'Stock removed / damaged';
      } else if (input.mode === 'set') {
        newQty = input.quantity;
        defaultReason = 'Stock count correction';
      }

      if (newQty < 0) {
        throw new ValidationError('Stock quantity cannot become negative.');
      }

      const deltaQty = newQty - previousQty;
      const updatedProduct: Product = {
        ...product,
        stockQty: newQty,
        updatedAt: nowIso,
      };

      const movement: StockMovement = {
        id: createId('stk'),
        operationId: input.operationId,
        productId: product.id,
        productNameSnapshot: product.name,
        type: input.mode === 'add' ? 'restock' : 'adjustment',
        deltaQty,
        previousQty,
        newQty,
        reason: (input.reason ?? '').trim() || defaultReason,
        relatedSaleId: null,
        createdAt: nowIso,
      };

      await ctx.put(STORES.products, updatedProduct);
      await ctx.add(STORES.stockMovements, movement);
      if (!product.isDemo) {
        await enqueueOutboxInTx(ctx, {
          operationId: input.operationId,
          opType: 'stock.adjust',
          createdAt: nowIso,
          payload: {
            productId: product.id,
            mode: input.mode,
            quantity: input.quantity,
            movement,
            updatedAt: nowIso,
          },
        });
      }

      return { product: updatedProduct, movement };
    }
  );
}

/**
 * Lists recent stock movements, optionally filtered to a single product.
 */
export async function listStockMovements(options: {
  productId?: string;
  limit?: number;
} = {}): Promise<StockMovement[]> {
  const limit = options.limit ?? 50;
  const rows = await runTransaction([STORES.stockMovements], 'readonly', (ctx) =>
    options.productId
      ? ctx.getAllByIndex(STORES.stockMovements, 'by_productId', options.productId)
      : ctx.getAll(STORES.stockMovements)
  );
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
