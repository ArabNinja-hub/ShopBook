import {
  enqueueOutboxInTx,
  LocalSyncStateRecord,
  runTransaction,
  STORES,
  SyncOutboxRecord,
  TxContext,
} from '../db/indexedDb';
import {
  CreditTransaction,
  Customer,
  Product,
  Sale,
  SaleItem,
  ShopSettings,
  StockMovement,
} from '../domain/types';
import {
  AuthShopView,
  StockConflictNotice,
  SyncLedgerEntryView,
  SyncOperationEnvelope,
  SyncPullResponse,
  SyncPushResponse,
} from '../shared/syncTypes';
import { apiRequest } from './apiClient';

export class UnsyncedChangesWarningError extends Error {
  public readonly pendingCount: number;

  constructor(pendingCount: number, message?: string) {
    super(
      message ??
        `Warning: ${pendingCount} offline shop record(s) have not been synchronized yet. Sync now or download a JSON backup before clearing local data.`
    );
    this.name = 'UnsyncedChangesWarningError';
    this.pendingCount = pendingCount;
  }
}

export class UnboundLocalDataDecisionRequiredError extends Error {
  public readonly localRecordCount: number;

  constructor(localRecordCount: number) {
    super(
      `This device already has ${localRecordCount} local shop record(s). Choose whether to sync them into this shop account or replace local data after downloading a backup.`
    );
    this.name = 'UnboundLocalDataDecisionRequiredError';
    this.localRecordCount = localRecordCount;
  }
}

export class ShopBindingMismatchError extends Error {
  public readonly boundShopId: string;
  public readonly boundShopName: string;
  public readonly targetShopId: string;
  public readonly pendingCount: number;

  constructor(params: {
    boundShopId: string;
    boundShopName: string;
    targetShopId: string;
    pendingCount: number;
  }) {
    super(
      `This browser currently stores local records for "${params.boundShopName}". Switching shops requires explicit confirmation so shop data is never mixed.`
    );
    this.name = 'ShopBindingMismatchError';
    this.boundShopId = params.boundShopId;
    this.boundShopName = params.boundShopName;
    this.targetShopId = params.targetShopId;
    this.pendingCount = params.pendingCount;
  }
}

export interface LocalSyncOverview {
  boundShopId: string | null;
  boundShopName: string | null;
  boundUserId: string | null;
  cursor: number;
  pendingOutboxCount: number;
  nonDemoLocalRecordCount: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  openStockConflicts: StockConflictNotice[];
}

function makeDefaultSyncState(): LocalSyncStateRecord {
  return {
    key: 'accountSync',
    boundShopId: null,
    boundShopName: null,
    boundUserId: null,
    cursor: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    openStockConflicts: [],
  };
}

function isRealRecord(item: { isDemo?: boolean; name?: string }): boolean {
  if (item.isDemo) return false;
  if (typeof item.name === 'string' && item.name.startsWith('[DEMO]')) {
    return false;
  }
  return true;
}

export async function getLocalSyncOverview(): Promise<LocalSyncOverview> {
  return runTransaction(
    [
      STORES.syncState,
      STORES.syncOutbox,
      STORES.products,
      STORES.sales,
      STORES.customers,
      STORES.creditTransactions,
    ],
    'readonly',
    async (ctx) => {
      const [state, outbox, products, sales, customers, creditTxs] =
        await Promise.all([
          ctx.get(STORES.syncState, 'accountSync'),
          ctx.getAll(STORES.syncOutbox),
          ctx.getAll(STORES.products),
          ctx.getAll(STORES.sales),
          ctx.getAll(STORES.customers),
          ctx.getAll(STORES.creditTransactions),
        ]);

      const realCount =
        products.filter(isRealRecord).length +
        sales.filter((s) => !s.isDemo).length +
        customers.filter(isRealRecord).length +
        creditTxs.filter((t) => !t.isDemo).length;

      const s = state ?? makeDefaultSyncState();
      return {
        boundShopId: s.boundShopId,
        boundShopName: s.boundShopName,
        boundUserId: s.boundUserId,
        cursor: s.cursor,
        pendingOutboxCount: outbox.length,
        nonDemoLocalRecordCount: realCount,
        lastSyncedAt: s.lastSyncedAt,
        lastSyncError: s.lastSyncError,
        openStockConflicts: s.openStockConflicts ?? [],
      };
    }
  );
}

/**
 * Idempotently queues any pre-existing non-demo local records (for example, records saved in
 * Milestone 1 `v1` before upgrading to `v2`, or restored from a JSON backup) into `syncOutbox`
 * in strict dependency order so zero historical transactions are lost on account registration.
 */
export async function enqueueExistingLocalLedgerInTx(
  ctx: TxContext
): Promise<number> {
  const [
    settings,
    existingOutbox,
    allProducts,
    allCustomers,
    allSales,
    allSaleItems,
    allMovements,
    allCreditTxs,
  ] = await Promise.all([
    ctx.get(STORES.meta, 'shopSettings'),
    ctx.getAll(STORES.syncOutbox),
    ctx.getAll(STORES.products),
    ctx.getAll(STORES.customers),
    ctx.getAll(STORES.sales),
    ctx.getAll(STORES.saleItems),
    ctx.getAll(STORES.stockMovements),
    ctx.getAll(STORES.creditTransactions),
  ]);

  const queuedProductCreates = new Set<string>();
  const queuedCustomerCreates = new Set<string>();
  const queuedOpIds = new Set<string>();

  for (const item of existingOutbox) {
    queuedOpIds.add(item.operationId);
    if (item.opType === 'product.create') {
      const p = (item.payload as { product: Product }).product;
      queuedProductCreates.add(p.id);
    } else if (item.opType === 'customer.create') {
      const c = (item.payload as { customer: Customer }).customer;
      queuedCustomerCreates.add(c.id);
    }
  }

  let enqueuedCount = 0;

  const realProducts = allProducts.filter(isRealRecord);
  const realCustomers = allCustomers.filter(isRealRecord);
  const realSales = allSales.filter((s) => !s.isDemo);
  const realMovements = allMovements.filter((m) => !m.isDemo);
  const realCreditTxs = allCreditTxs.filter((t) => !t.isDemo);

  const movementsByProduct = new Map<string, StockMovement[]>();
  for (const m of realMovements) {
    const list = movementsByProduct.get(m.productId);
    if (list) list.push(m);
    else movementsByProduct.set(m.productId, [m]);
  }

  // 1. Products (opening stock reconstructed so opening + movements === current stockQty)
  for (const prod of realProducts) {
    if (queuedProductCreates.has(prod.id)) continue;

    const prodMoves = movementsByProduct.get(prod.id) ?? [];
    const initialMove = prodMoves.find((m) => m.type === 'initial');
    const nonInitialMoves = prodMoves.filter((m) => m.type !== 'initial');
    const netLaterDelta = nonInitialMoves.reduce(
      (sum, m) => sum + m.deltaQty,
      0
    );

    const openingQty = initialMove
      ? initialMove.newQty
      : Math.max(0, prod.stockQty - netLaterDelta);

    const createOpId = initialMove?.operationId ?? `boot_prd_${prod.id}`;
    if (!queuedOpIds.has(createOpId)) {
      const syntheticInitial: StockMovement = initialMove ?? {
        id: `stk_boot_${prod.id}`,
        operationId: createOpId,
        productId: prod.id,
        productNameSnapshot: prod.name,
        type: 'initial',
        deltaQty: openingQty,
        previousQty: 0,
        newQty: openingQty,
        reason: 'Opening stock',
        relatedSaleId: null,
        createdAt: prod.createdAt,
      };

      await enqueueOutboxInTx(ctx, {
        operationId: createOpId,
        opType: 'product.create',
        createdAt: prod.createdAt,
        payload: {
          product: { ...prod, stockQty: openingQty },
          initialMovement: syntheticInitial,
        },
      });
      queuedOpIds.add(createOpId);
      enqueuedCount += 1;
    }

    if (prod.isArchived) {
      const archOpId = `boot_arch_${prod.id}`;
      if (!queuedOpIds.has(archOpId)) {
        await enqueueOutboxInTx(ctx, {
          operationId: archOpId,
          opType: 'product.archive',
          createdAt: prod.updatedAt,
          payload: {
            productId: prod.id,
            isArchived: true,
            updatedAt: prod.updatedAt,
          },
        });
        queuedOpIds.add(archOpId);
        enqueuedCount += 1;
      }
    }
  }

  // 2. Customers
  for (const cust of realCustomers) {
    if (queuedCustomerCreates.has(cust.id)) continue;
    const custOpId = `boot_cus_${cust.id}`;
    if (!queuedOpIds.has(custOpId)) {
      await enqueueOutboxInTx(ctx, {
        operationId: custOpId,
        opType: 'customer.create',
        createdAt: cust.createdAt,
        payload: { customer: cust },
      });
      queuedOpIds.add(custOpId);
      enqueuedCount += 1;
    }
  }

  // 3. Sales, standalone stock adjustments, and repayments in chronological order
  const itemsBySaleId = new Map<string, SaleItem[]>();
  for (const item of allSaleItems) {
    if (item.isDemo) continue;
    const list = itemsBySaleId.get(item.saleId);
    if (list) list.push(item);
    else itemsBySaleId.set(item.saleId, [item]);
  }

  const movesBySaleId = new Map<string, StockMovement[]>();
  const standaloneMoves: StockMovement[] = [];
  for (const m of realMovements) {
    if (m.type === 'initial') continue;
    if (m.relatedSaleId) {
      const list = movesBySaleId.get(m.relatedSaleId);
      if (list) list.push(m);
      else movesBySaleId.set(m.relatedSaleId, [m]);
    } else {
      standaloneMoves.push(m);
    }
  }

  const creditBySaleId = new Map<string, CreditTransaction>();
  const repayments: CreditTransaction[] = [];
  for (const tx of realCreditTxs) {
    if (tx.type === 'credit_sale' && tx.relatedSaleId) {
      creditBySaleId.set(tx.relatedSaleId, tx);
    } else if (tx.type === 'repayment') {
      repayments.push(tx);
    }
  }

  type TimelineEvent =
    | { createdAt: string; kind: 'sale'; sale: Sale }
    | { createdAt: string; kind: 'adjust'; move: StockMovement }
    | { createdAt: string; kind: 'repay'; repay: CreditTransaction };

  const timeline: TimelineEvent[] = [
    ...realSales.map((sale) => ({
      createdAt: sale.createdAt,
      kind: 'sale' as const,
      sale,
    })),
    ...standaloneMoves.map((move) => ({
      createdAt: move.createdAt,
      kind: 'adjust' as const,
      move,
    })),
    ...repayments.map((repay) => ({
      createdAt: repay.createdAt,
      kind: 'repay' as const,
      repay,
    })),
  ].sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt);
    if (cmp !== 0) return cmp;
    const order = { adjust: 0, sale: 1, repay: 2 };
    return order[a.kind] - order[b.kind];
  });

  for (const ev of timeline) {
    if (ev.kind === 'sale') {
      const s = ev.sale;
      if (queuedOpIds.has(s.operationId)) continue;
      const saleItems = itemsBySaleId.get(s.id) ?? [];
      if (saleItems.length === 0) continue;

      const saleMoves =
        movesBySaleId.get(s.id) ??
        saleItems.map((it) => ({
          id: `stk_boot_${it.id}`,
          operationId: `${s.operationId}_stk_${it.productId}`,
          productId: it.productId,
          productNameSnapshot: it.productNameAtSale,
          type: 'sale' as const,
          deltaQty: -it.quantity,
          previousQty: it.quantity,
          newQty: 0,
          reason: `Sale ${s.receiptNumber}`,
          relatedSaleId: s.id,
          createdAt: s.createdAt,
        }));

      await enqueueOutboxInTx(ctx, {
        operationId: s.operationId,
        opType: 'sale.record',
        createdAt: s.createdAt,
        payload: {
          sale: s,
          saleItems,
          stockMovements: saleMoves,
          creditTransaction: creditBySaleId.get(s.id) ?? null,
        },
      });
      queuedOpIds.add(s.operationId);
      enqueuedCount += 1;
    } else if (ev.kind === 'adjust') {
      const m = ev.move;
      if (queuedOpIds.has(m.operationId)) continue;
      const mode =
        m.deltaQty > 0 ? 'add' : m.deltaQty < 0 ? 'subtract' : 'set';
      const quantity =
        mode === 'set' ? m.newQty : Math.abs(m.deltaQty);

      await enqueueOutboxInTx(ctx, {
        operationId: m.operationId,
        opType: 'stock.adjust',
        createdAt: m.createdAt,
        payload: {
          productId: m.productId,
          mode,
          quantity,
          movement: m,
          updatedAt: m.createdAt,
        },
      });
      queuedOpIds.add(m.operationId);
      enqueuedCount += 1;
    } else if (ev.kind === 'repay') {
      const r = ev.repay;
      if (queuedOpIds.has(r.operationId)) continue;
      await enqueueOutboxInTx(ctx, {
        operationId: r.operationId,
        opType: 'credit.repayment',
        createdAt: r.createdAt,
        payload: {
          repayment: r,
          customerUpdatedAt: r.createdAt,
        },
      });
      queuedOpIds.add(r.operationId);
      enqueuedCount += 1;
    }
  }

  // 4. Shop display name if customized
  if (settings && settings.shopName && settings.shopName !== 'My Shop') {
    const nameOpId = `boot_shop_name_${settings.updatedAt}`;
    if (!queuedOpIds.has(nameOpId)) {
      await enqueueOutboxInTx(ctx, {
        operationId: nameOpId,
        opType: 'shop.update_name',
        createdAt: settings.updatedAt,
        payload: {
          shopName: settings.shopName,
          updatedAt: settings.updatedAt,
        },
      });
      enqueuedCount += 1;
    }
  }

  return enqueuedCount;
}

/**
 * Binds the current device's local IndexedDB to `shop` and optionally claims/enqueues
 * existing local records (used right after creating a new account or confirming local merge).
 */
export async function bindLocalLedgerToShop(options: {
  shopId: string;
  shopName: string;
  userId: string;
  claimExistingLocalRecords: boolean;
}): Promise<void> {
  await runTransaction(
    [
      STORES.meta,
      STORES.syncState,
      STORES.syncOutbox,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
    ],
    'readwrite',
    async (ctx) => {
      if (options.claimExistingLocalRecords) {
        await enqueueExistingLocalLedgerInTx(ctx);
      }

      const prev =
        (await ctx.get(STORES.syncState, 'accountSync')) ??
        makeDefaultSyncState();

      await ctx.put(STORES.syncState, {
        ...prev,
        key: 'accountSync',
        boundShopId: options.shopId,
        boundShopName: options.shopName,
        boundUserId: options.userId,
        cursor: prev.boundShopId === options.shopId ? prev.cursor : 0,
      });

      const currentSettings = await ctx.get(STORES.meta, 'shopSettings');
      const nowIso = new Date().toISOString();
      if (!currentSettings || currentSettings.shopName === 'My Shop') {
        await ctx.put(STORES.meta, {
          key: 'shopSettings',
          shopName: options.shopName,
          hasDemoData: currentSettings?.hasDemoData ?? false,
          lastBackupAt: currentSettings?.lastBackupAt ?? null,
          createdAt: currentSettings?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
      }
    }
  );
}

/**
 * Clears local IndexedDB stores to switch to a different shop or sign out on a shared phone.
 * Refuses to erase unsynced offline mutations unless `forceDiscardUnsynced === true`.
 */
export async function resetLocalStoresForShopSwitchOrSignOut(options: {
  newShop?: { shopId: string; shopName: string; userId: string } | null;
  forceDiscardUnsynced?: boolean;
}): Promise<void> {
  await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
      STORES.syncOutbox,
      STORES.syncState,
    ],
    'readwrite',
    async (ctx) => {
      const pending = await ctx.getAll(STORES.syncOutbox);
      if (pending.length > 0 && !options.forceDiscardUnsynced) {
        throw new UnsyncedChangesWarningError(pending.length);
      }

      await ctx.clear(STORES.meta);
      await ctx.clear(STORES.products);
      await ctx.clear(STORES.sales);
      await ctx.clear(STORES.saleItems);
      await ctx.clear(STORES.stockMovements);
      await ctx.clear(STORES.customers);
      await ctx.clear(STORES.creditTransactions);
      await ctx.clear(STORES.syncOutbox);
      await ctx.clear(STORES.syncState);

      const nowIso = new Date().toISOString();
      const targetName = options.newShop?.shopName ?? 'My Shop';
      const freshSettings: ShopSettings = {
        key: 'shopSettings',
        shopName: targetName,
        hasDemoData: false,
        lastBackupAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await ctx.put(STORES.meta, freshSettings);

      if (options.newShop) {
        await ctx.put(STORES.syncState, {
          key: 'accountSync',
          boundShopId: options.newShop.shopId,
          boundShopName: options.newShop.shopName,
          boundUserId: options.newShop.userId,
          cursor: 0,
          lastSyncedAt: null,
          lastSyncError: null,
          openStockConflicts: [],
        });
      }
    }
  );
}

function computePendingLocalDeltaForProduct(
  outbox: SyncOutboxRecord[],
  productId: string
): number {
  let delta = 0;
  for (const op of outbox) {
    if (op.opType === 'sale.record') {
      const payload = op.payload as { saleItems: SaleItem[] };
      for (const it of payload.saleItems) {
        if (it.productId === productId) {
          delta -= it.quantity;
        }
      }
    } else if (op.opType === 'stock.adjust') {
      const payload = op.payload as {
        productId: string;
        mode: 'add' | 'subtract' | 'set';
        quantity: number;
      };
      if (payload.productId === productId) {
        if (payload.mode === 'add') delta += payload.quantity;
        else if (payload.mode === 'subtract') delta -= payload.quantity;
      }
    }
  }
  return delta;
}

async function applyPulledPageAtomically(
  shop: AuthShopView,
  userId: string,
  pullResponse: SyncPullResponse
): Promise<void> {
  await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
      STORES.syncOutbox,
      STORES.syncState,
    ],
    'readwrite',
    async (ctx) => {
      const remainingOutbox = await ctx.getAll(STORES.syncOutbox);

      for (const entry of pullResponse.entries) {
        await applySingleLedgerEntry(ctx, entry, remainingOutbox);
      }

      const prevState =
        (await ctx.get(STORES.syncState, 'accountSync')) ??
        makeDefaultSyncState();

      await ctx.put(STORES.syncState, {
        ...prevState,
        key: 'accountSync',
        boundShopId: shop.id,
        boundShopName: pullResponse.shopName || shop.name,
        boundUserId: userId,
        cursor: pullResponse.nextCursor,
        lastSyncedAt: pullResponse.serverTime,
        lastSyncError: null,
        openStockConflicts: pullResponse.openStockConflicts ?? [],
      });
    }
  );
}

async function applySingleLedgerEntry(
  ctx: TxContext,
  entry: SyncLedgerEntryView,
  remainingOutbox: SyncOutboxRecord[]
): Promise<void> {
  switch (entry.entityType) {
    case 'shop_settings': {
      const rec = entry.record as { shopName: string; updatedAt: string };
      const existing = await ctx.get(STORES.meta, 'shopSettings');
      const nowIso = new Date().toISOString();
      await ctx.put(STORES.meta, {
        key: 'shopSettings',
        shopName: rec.shopName,
        hasDemoData: existing?.hasDemoData ?? false,
        lastBackupAt: existing?.lastBackupAt ?? null,
        createdAt: existing?.createdAt ?? rec.updatedAt ?? nowIso,
        updatedAt: rec.updatedAt ?? nowIso,
      });
      break;
    }

    case 'product': {
      const serverProduct = entry.record as Product;
      const pendingDelta = computePendingLocalDeltaForProduct(
        remainingOutbox,
        serverProduct.id
      );
      await ctx.put(STORES.products, {
        ...serverProduct,
        stockQty: Math.max(0, serverProduct.stockQty + pendingDelta),
      });
      break;
    }

    case 'customer': {
      const customer = entry.record as Customer;
      await ctx.put(STORES.customers, customer);
      break;
    }

    case 'sale': {
      const bundle = entry.record as { sale: Sale; saleItems: SaleItem[] };
      const existingByOp = await ctx.getOneByIndex(
        STORES.sales,
        'by_operationId',
        bundle.sale.operationId
      );
      if (existingByOp && existingByOp.id !== bundle.sale.id) {
        await ctx.delete(STORES.sales, existingByOp.id);
      }
      await ctx.put(STORES.sales, bundle.sale);
      for (const item of bundle.saleItems) {
        await ctx.put(STORES.saleItems, item);
      }
      break;
    }

    case 'stock_movement': {
      const movement = entry.record as StockMovement;
      const existingByOp = await ctx.getOneByIndex(
        STORES.stockMovements,
        'by_operationId',
        movement.operationId
      );
      if (existingByOp && existingByOp.id !== movement.id) {
        await ctx.delete(STORES.stockMovements, existingByOp.id);
      }
      await ctx.put(STORES.stockMovements, movement);
      break;
    }

    case 'credit_transaction': {
      const creditTx = entry.record as CreditTransaction;
      const existingByOp = await ctx.getOneByIndex(
        STORES.creditTransactions,
        'by_operationId',
        creditTx.operationId
      );
      if (existingByOp && existingByOp.id !== creditTx.id) {
        await ctx.delete(STORES.creditTransactions, existingByOp.id);
      }
      await ctx.put(STORES.creditTransactions, creditTx);
      break;
    }

    case 'stock_conflict': {
      // Final openStockConflicts snapshot is saved from pullResponse.openStockConflicts
      break;
    }
  }
}

let inFlightSync: Promise<LocalSyncOverview> | null = null;

/**
 * Runs a full two-phase synchronization cycle (1. FIFO Push Outbox -> 2. Cursor Pull Ledger)
 * for the authenticated shop. Safe to invoke concurrently; overlapping callers await the
 * same active sync run.
 */
export async function syncWithServer(options: {
  shop: AuthShopView;
  userId: string;
}): Promise<LocalSyncOverview> {
  if (inFlightSync) {
    return inFlightSync;
  }

  inFlightSync = executeSyncCycle(options).finally(() => {
    inFlightSync = null;
  });

  return inFlightSync;
}

async function executeSyncCycle(options: {
  shop: AuthShopView;
  userId: string;
}): Promise<LocalSyncOverview> {
  const { shop, userId } = options;
  const overviewBefore = await getLocalSyncOverview();

  // Safety Guard 1: Never mix data across two different shops on the same browser
  if (
    overviewBefore.boundShopId !== null &&
    overviewBefore.boundShopId !== shop.id
  ) {
    throw new ShopBindingMismatchError({
      boundShopId: overviewBefore.boundShopId,
      boundShopName: overviewBefore.boundShopName ?? 'Previous Shop',
      targetShopId: shop.id,
      pendingCount: overviewBefore.pendingOutboxCount,
    });
  }

  // Safety Guard 2: If device was previously local-only and already has non-demo shop data,
  // require explicit user confirmation before merging into an existing shop account.
  if (overviewBefore.boundShopId === null) {
    if (
      overviewBefore.nonDemoLocalRecordCount > 0 ||
      overviewBefore.pendingOutboxCount > 0
    ) {
      throw new UnboundLocalDataDecisionRequiredError(
        Math.max(
          overviewBefore.nonDemoLocalRecordCount,
          overviewBefore.pendingOutboxCount
        )
      );
    }

    await bindLocalLedgerToShop({
      shopId: shop.id,
      shopName: shop.name,
      userId,
      claimExistingLocalRecords: false,
    });
  }

  try {
    // Phase 1: Flush local outbox in ordered FIFO batches of 50
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await runTransaction(
        [STORES.syncOutbox],
        'readonly',
        async (ctx) => {
          const all = await ctx.getAll(STORES.syncOutbox);
          return all
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .slice(0, 50);
        }
      );

      if (batch.length === 0) {
        break;
      }

      const operations: SyncOperationEnvelope[] = batch.map((row) => ({
        operationId: row.operationId,
        opType: row.opType,
        createdAt: row.createdAt,
        payload: row.payload,
      }));

      const pushRes = await apiRequest<SyncPushResponse>('/api/v1/sync/push', {
        method: 'POST',
        shopId: shop.id,
        body: { operations },
      });

      const ackedByOpId = new Map(
        pushRes.results.map((r) => [r.operationId, r])
      );

      await runTransaction(
        [STORES.syncOutbox, STORES.sales, STORES.syncState],
        'readwrite',
        async (ctx) => {
          for (const row of batch) {
            const ack = ackedByOpId.get(row.operationId);
            if (ack && row.seq !== undefined) {
              await ctx.delete(STORES.syncOutbox, row.seq);
            }

            if (ack?.reassignedReceiptNumber) {
              const localSale = await ctx.getOneByIndex(
                STORES.sales,
                'by_operationId',
                row.operationId
              );
              if (localSale) {
                await ctx.put(STORES.sales, {
                  ...localSale,
                  receiptNumber: ack.reassignedReceiptNumber,
                });
              }
            }
          }

          const curState =
            (await ctx.get(STORES.syncState, 'accountSync')) ??
            makeDefaultSyncState();
          await ctx.put(STORES.syncState, {
            ...curState,
            key: 'accountSync',
            boundShopId: shop.id,
            boundShopName: shop.name,
            boundUserId: userId,
            openStockConflicts: pushRes.openStockConflicts ?? [],
            lastSyncError: null,
          });
        }
      );
    }

    // Phase 2: Pull canonical server ledger updates from cursor
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentState = await runTransaction(
        [STORES.syncState],
        'readonly',
        async (ctx) =>
          (await ctx.get(STORES.syncState, 'accountSync')) ??
          makeDefaultSyncState()
      );

      const pullRes = await apiRequest<SyncPullResponse>(
        `/api/v1/sync/pull?afterCursor=${currentState.cursor}&limit=200`,
        {
          method: 'GET',
          shopId: shop.id,
        }
      );

      await applyPulledPageAtomically(shop, userId, pullRes);

      if (!pullRes.hasMore) {
        break;
      }
    }

    return await getLocalSyncOverview();
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Sync interrupted. Will retry.';
    await runTransaction([STORES.syncState], 'readwrite', async (ctx) => {
      const curState =
        (await ctx.get(STORES.syncState, 'accountSync')) ??
        makeDefaultSyncState();
      await ctx.put(STORES.syncState, {
        ...curState,
        key: 'accountSync',
        lastSyncError: msg,
      });
    });
    throw err;
  }
}

export async function acknowledgeStockConflictOnServer(
  shopId: string,
  conflictId: string
): Promise<void> {
  await apiRequest(`/api/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
    method: 'POST',
    shopId,
  });

  await runTransaction([STORES.syncState], 'readwrite', async (ctx) => {
    const curState = await ctx.get(STORES.syncState, 'accountSync');
    if (!curState) return;
    await ctx.put(STORES.syncState, {
      ...curState,
      openStockConflicts: (curState.openStockConflicts ?? []).filter(
        (c) => c.id !== conflictId
      ),
    });
  });
}
