import 'fake-indexeddb/auto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServerApp } from '../../server/app';
import { loadServerConfig, ServerConfig } from '../../server/config';
import { createDatabaseContext, DatabaseContext } from '../../server/db/client';
import { runMigrations } from '../../server/db/migrate';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../../server/middleware/csrf';
import {
  closeShopDatabase,
  DB_NAME,
  openShopDatabase,
  resetDatabaseForTests,
} from '../db/indexedDb';
import { createId } from '../domain/ids';
import {
  Product,
  Sale,
  SaleItem,
  ShopSettings,
  StockMovement,
} from '../domain/types';
import { FetchLike, setApiFetchAdapter } from '../services/apiClient';
import {
  loginAccount,
  registerOwnerAccount,
} from '../services/authClientService';
import {
  createCustomer,
  listCustomersWithBalances,
  recordRepayment,
} from '../services/creditService';
import { listSalesWithItems, recordSale } from '../services/salesService';
import { loadSampleDemoData } from '../services/shopService';
import {
  adjustProductStock,
  createProduct,
  listProducts,
} from '../services/stockService';
import { getDaySummary } from '../services/summaryService';
import {
  bindLocalLedgerToShop,
  getLocalSyncOverview,
  resetLocalStoresForShopSwitchOrSignOut,
  ShopBindingMismatchError,
  syncWithServer,
  UnsyncedChangesWarningError,
} from '../services/syncClientService';
import { SyncOperationEnvelope, SyncPushResponse } from '../shared/syncTypes';

/**
 * Creates a cookie-jar-backed `fetch` adapter wired directly to Fastify `.inject()`
 * so full browser -> API -> PostgreSQL round-trips run deterministically in tests.
 */
function createFastifyCookieFetch(
  app: FastifyInstance,
  options: { failNextPathSubstring?: string | null } = {}
): { fetchAdapter: FetchLike; getCookieHeader: () => string } {
  let cookiePair = '';

  const fetchAdapter: FetchLike = async (url, init) => {
    if (
      options.failNextPathSubstring &&
      url.includes(options.failNextPathSubstring)
    ) {
      options.failNextPathSubstring = null;
      throw new Error('Simulated 2G/3G connection drop');
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(
        init.headers as Record<string, string>
      )) {
        headers[k.toLowerCase()] = v;
      }
    }
    if (cookiePair) {
      headers.cookie = cookiePair;
    }

    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });

    const setCookie = res.headers['set-cookie'];
    const rawSetCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (rawSetCookie) {
      const pair = rawSetCookie.split(';')[0];
      if (pair.endsWith('=')) {
        cookiePair = '';
      } else {
        cookiePair = pair;
      }
    }

    return new Response(res.body, {
      status: res.statusCode,
      headers: {
        'content-type': String(
          res.headers['content-type'] ?? 'application/json'
        ),
      },
    });
  };

  return {
    fetchAdapter,
    getCookieHeader: () => cookiePair,
  };
}

describe('Milestone 2 Stage 2 — v1->v2 Migration Safety, Atomic Outbox, Idempotency, Concurrency & Conflict Handling', () => {
  let dbCtx: DatabaseContext;
  let config: ServerConfig;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadServerConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      COOKIE_SECURE: 'false',
      DEFAULT_PILOT_EXEMPT: 'true',
      ENFORCE_SUBSCRIPTIONS: 'false',
    });
    dbCtx = await createDatabaseContext({ databaseUrl: config.databaseUrl });
    await runMigrations(dbCtx);
    app = await buildServerApp({ dbCtx, config });
  });

  afterAll(async () => {
    setApiFetchAdapter(null);
    await app.close();
    await dbCtx.close();
  });

  beforeEach(async () => {
    setApiFetchAdapter(null);
    await resetDatabaseForTests();
    await dbCtx.execRawSql(`
      TRUNCATE
        audit_logs,
        sync_ledger,
        applied_operations,
        stock_conflicts,
        credit_transactions,
        stock_movements,
        sale_items,
        sales,
        customers,
        products,
        shop_entitlements,
        password_reset_tokens,
        auth_sessions,
        shop_members,
        shops,
        users
      RESTART IDENTITY CASCADE;
    `);
  });

  it('upgrades a real Milestone 1 (v1) IndexedDB database to v2 without losing any records and syncs them cleanly on registration', async () => {
    await closeShopDatabase();

    // 1. Seed a genuine Milestone 1 Version-1 IndexedDB database (7 stores, no syncOutbox/syncState)
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('products', { keyPath: 'id' }).createIndex('by_name', 'name');
        const sales = db.createObjectStore('sales', { keyPath: 'id' });
        sales.createIndex('by_operationId', 'operationId', { unique: true });
        sales.createIndex('by_localDate', 'localDate');
        sales.createIndex('by_customerId', 'customerId');
        sales.createIndex('by_createdAt', 'createdAt');
        const items = db.createObjectStore('saleItems', { keyPath: 'id' });
        items.createIndex('by_saleId', 'saleId');
        items.createIndex('by_productId', 'productId');
        const moves = db.createObjectStore('stockMovements', { keyPath: 'id' });
        moves.createIndex('by_operationId', 'operationId', { unique: true });
        moves.createIndex('by_productId', 'productId');
        moves.createIndex('by_createdAt', 'createdAt');
        db.createObjectStore('customers', { keyPath: 'id' }).createIndex('by_name', 'name');
        const credits = db.createObjectStore('creditTransactions', { keyPath: 'id' });
        credits.createIndex('by_operationId', 'operationId', { unique: true });
        credits.createIndex('by_customerId', 'customerId');
        credits.createIndex('by_localDate', 'localDate');
        credits.createIndex('by_createdAt', 'createdAt');
      };

      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(
          ['meta', 'products', 'sales', 'saleItems', 'stockMovements'],
          'readwrite'
        );
        const nowIso = '2026-10-23T08:00:00.000Z';
        const v1Settings: ShopSettings = {
          key: 'shopSettings',
          shopName: 'Chingola Corner Kiosk',
          hasDemoData: false,
          lastBackupAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const v1Product: Product = {
          id: 'prd_v1_mealie',
          name: 'Breakfast Meal 25kg',
          unitLabel: '25kg bag',
          sellingPriceNgwee: 31000,
          costPriceNgwee: 27500,
          stockQty: 8, // Started at 10, sold 2 in v1 -> 8 remaining
          lowStockThreshold: 5,
          isArchived: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const v1InitMove: StockMovement = {
          id: 'stk_v1_init',
          operationId: 'op_v1_init',
          productId: v1Product.id,
          productNameSnapshot: v1Product.name,
          type: 'initial',
          deltaQty: 10,
          previousQty: 0,
          newQty: 10,
          reason: 'Opening stock',
          relatedSaleId: null,
          createdAt: nowIso,
        };
        const saleIso = '2026-10-23T09:15:00.000Z';
        const v1Sale: Sale = {
          id: 'sal_v1_1',
          operationId: 'op_v1_sale1',
          receiptNumber: 'SB-20261023-001',
          paymentMethod: 'cash',
          paymentReference: null,
          customerId: null,
          customerNameSnapshot: null,
          totalNgwee: 62000,
          totalUnits: 2,
          knownCostTotalNgwee: 55000,
          knownCostRevenueNgwee: 62000,
          missingCostLineCount: 0,
          missingCostRevenueNgwee: 0,
          note: 'Morning cash sale',
          createdAt: saleIso,
          localDate: '2026-10-23',
        };
        const v1SaleItem: SaleItem = {
          id: 'sli_v1_1',
          saleId: v1Sale.id,
          productId: v1Product.id,
          productNameAtSale: v1Product.name,
          unitLabelAtSale: v1Product.unitLabel,
          sellingPriceAtSaleNgwee: 31000,
          costPriceAtSaleNgwee: 27500,
          quantity: 2,
          lineTotalNgwee: 62000,
          createdAt: saleIso,
        };
        const v1SaleMove: StockMovement = {
          id: 'stk_v1_sale1',
          operationId: 'op_v1_sale1_stk',
          productId: v1Product.id,
          productNameSnapshot: v1Product.name,
          type: 'sale',
          deltaQty: -2,
          previousQty: 10,
          newQty: 8,
          reason: 'Sale SB-20261023-001',
          relatedSaleId: v1Sale.id,
          createdAt: saleIso,
        };

        tx.objectStore('meta').put(v1Settings);
        tx.objectStore('products').add(v1Product);
        tx.objectStore('stockMovements').add(v1InitMove);
        tx.objectStore('sales').add(v1Sale);
        tx.objectStore('saleItems').add(v1SaleItem);
        tx.objectStore('stockMovements').add(v1SaleMove);

        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // 2. Open upgraded v2 database and verify 100% of v1 records survived untouched
    const upgradedDb = await openShopDatabase();
    expect(upgradedDb.version).toBe(2);
    expect(upgradedDb.objectStoreNames.contains('syncOutbox')).toBe(true);
    expect(upgradedDb.objectStoreNames.contains('syncState')).toBe(true);

    // Also load [DEMO] sample data to prove demo data is NEVER uploaded to PostgreSQL
    await loadSampleDemoData(new Date('2026-10-23T09:30:00Z'));

    const client = createFastifyCookieFetch(app);
    setApiFetchAdapter(client.fetchAdapter);

    // 3. Register owner account and claim pre-existing v1 local shop records
    const authRes = await registerOwnerAccount({
      fullName: 'Chanda Mwila',
      shopName: 'Chingola Corner Kiosk',
      phone: '0977334455',
      password: 'SafePilotPassword1!',
    });

    await bindLocalLedgerToShop({
      shopId: authRes.shop!.id,
      shopName: authRes.shop!.name,
      userId: authRes.user!.id,
      claimExistingLocalRecords: true,
    });
    const syncedOverview = await syncWithServer({
      shop: authRes.shop!,
      userId: authRes.user!.id,
    });
    expect(syncedOverview.pendingOutboxCount).toBe(0);

    // 4. Simulate a brand-new second phone signing in and pulling from cursor = 0
    await resetDatabaseForTests();
    const loginPhone2 = await loginAccount({
      identifier: '+260977334455',
      password: 'SafePilotPassword1!',
    });
    await syncWithServer({
      shop: loginPhone2.shop!,
      userId: loginPhone2.user!.id,
    });

    const phone2Products = await listProducts();
    expect(phone2Products).toHaveLength(1); // Only real v1 product, ZERO [DEMO] products!
    expect(phone2Products[0].name).toBe('Breakfast Meal 25kg');
    expect(phone2Products[0].stockQty).toBe(8);

    const phone2Summary = await getDaySummary('2026-10-23');
    expect(phone2Summary.salesCount).toBe(1);
    expect(phone2Summary.cashSalesNgwee).toBe(62000);
    expect(phone2Summary.estimatedGrossProfitNgwee).toBe(7000);
  });

  it('guarantees server idempotency on duplicate operation retries and recovers cleanly from interrupted sync', async () => {
    const networkToggle = { failNextPathSubstring: null as string | null };
    const client = createFastifyCookieFetch(app, networkToggle);
    setApiFetchAdapter(client.fetchAdapter);

    const reg = await registerOwnerAccount({
      fullName: 'Daka Shopkeeper',
      shopName: 'Lusaka Mini Mart',
      phone: '0966778899',
      password: 'PilotPassword888!',
    });
    await bindLocalLedgerToShop({
      shopId: reg.shop!.id,
      shopName: reg.shop!.name,
      userId: reg.user!.id,
      claimExistingLocalRecords: false,
    });

    // Record product, customer, credit sale, and repayment locally while offline
    const sugar = await createProduct({
      operationId: 'op_prod_sugar',
      name: 'White Sugar 2kg',
      unitLabel: 'pack',
      sellingPriceNgwee: 6800,
      costPriceNgwee: 5800,
      initialStockQty: 10,
      now: new Date('2026-10-23T10:00:00Z'),
    });
    const customer = await createCustomer({
      name: 'Grace Lungu',
      phone: '0977112233',
      now: new Date('2026-10-23T10:01:00Z'),
    });
    await recordSale({
      operationId: 'op_credit_sale_1',
      paymentMethod: 'credit',
      customerId: customer.id,
      items: [{ productId: sugar.id, quantity: 3 }], // 3 * K68 = K204.00
      now: new Date('2026-10-23T10:05:00Z'),
    });
    await recordRepayment({
      operationId: 'op_repay_1',
      customerId: customer.id,
      amountNgwee: 10000, // K100.00 cash repayment -> K104.00 owing
      paymentMethod: 'cash',
      now: new Date('2026-10-23T10:10:00Z'),
    });

    const beforeSync = await getLocalSyncOverview();
    expect(beforeSync.pendingOutboxCount).toBe(4);

    // Simulate network drop right after push succeeds when pull starts!
    networkToggle.failNextPathSubstring = '/api/v1/sync/pull';
    await expect(
      syncWithServer({ shop: reg.shop!, userId: reg.user!.id })
    ).rejects.toThrow();

    const midSync = await getLocalSyncOverview();
    expect(midSync.lastSyncError).toBeTruthy();

    // Retry sync once network recovers — completes cleanly without duplicating anything
    const afterRecovery = await syncWithServer({
      shop: reg.shop!,
      userId: reg.user!.id,
    });
    expect(afterRecovery.pendingOutboxCount).toBe(0);
    expect(afterRecovery.lastSyncError).toBeNull();

    // Also replay the exact same sale & repayment operationIds directly to /api/v1/sync/push
    // to prove server-side `applied_operations` returns `duplicate_noop` with zero double charges!
    const [savedSale] = await listSalesWithItems();
    const duplicatePushRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        cookie: client.getCookieHeader(),
      },
      payload: {
        operations: [
          {
            operationId: 'op_credit_sale_1',
            opType: 'sale.record',
            createdAt: savedSale.createdAt,
            payload: {
              sale: savedSale,
              saleItems: savedSale.items,
              stockMovements: [
                {
                  id: 'stk_dup_test',
                  operationId: 'op_credit_sale_1_stk',
                  productId: sugar.id,
                  productNameSnapshot: sugar.name,
                  type: 'sale',
                  deltaQty: -3,
                  previousQty: 10,
                  newQty: 7,
                  reason: 'Sale',
                  relatedSaleId: savedSale.id,
                  createdAt: savedSale.createdAt,
                },
              ],
              creditTransaction: null,
            },
          },
        ] satisfies SyncOperationEnvelope[],
      },
    });
    expect(duplicatePushRes.statusCode).toBe(200);
    const dupJson = duplicatePushRes.json() as SyncPushResponse;
    expect(dupJson.results[0].status).toBe('duplicate_noop');

    // Verify stock is still 7 (10 - 3) and Grace Lungu owes K104.00 (20400 - 10000 = 10400 ngwee)
    await syncWithServer({ shop: reg.shop!, userId: reg.user!.id });
    const [finalSugar] = await listProducts();
    expect(finalSugar.stockQty).toBe(7);

    const [graceSummary] = await listCustomersWithBalances();
    expect(graceSummary.totalCreditNgwee).toBe(20400);
    expect(graceSummary.totalRepaidNgwee).toBe(10000);
    expect(graceSummary.outstandingBalanceNgwee).toBe(10400);
  });

  it('handles concurrent multi-device stock updates and offline oversells without discarding completed sales or repayments', async () => {
    const client = createFastifyCookieFetch(app);
    setApiFetchAdapter(client.fetchAdapter);

    const reg = await registerOwnerAccount({
      fullName: 'Owner Zulu',
      shopName: 'Kitwe Central Store',
      phone: '0955443322',
      password: 'KitweShopPassword1',
    });
    await bindLocalLedgerToShop({
      shopId: reg.shop!.id,
      shopName: reg.shop!.name,
      userId: reg.user!.id,
      claimExistingLocalRecords: false,
    });

    const oil = await createProduct({
      name: 'Cooking Oil 2L',
      unitLabel: 'bottle',
      sellingPriceNgwee: 9200,
      costPriceNgwee: 7800,
      initialStockQty: 5, // Only 5 bottles in stock initially
      now: new Date('2026-10-23T08:00:00Z'),
    });
    const bread = await createProduct({
      name: 'Bread Loaf',
      unitLabel: 'loaf',
      sellingPriceNgwee: 2200,
      costPriceNgwee: 1800,
      initialStockQty: 5,
      now: new Date('2026-10-23T08:00:00Z'),
    });
    await syncWithServer({ shop: reg.shop!, userId: reg.user!.id });

    // Simulate Device A and Device B pushing concurrent offline operations!
    // Device A offline: sells 4 Cooking Oil (receipt SB-20261023-001) + restocks +10 Bread
    // Device B offline: sells 3 Cooking Oil (ALSO receipt SB-20261023-001!) + restocks +6 Bread
    const saleATime = '2026-10-23T11:00:00.000Z';
    const saleBTime = '2026-10-23T11:01:00.000Z';

    const deviceAOps: SyncOperationEnvelope[] = [
      {
        operationId: 'op_devA_sale_oil',
        opType: 'sale.record',
        createdAt: saleATime,
        payload: {
          sale: {
            id: 'sal_devA_1',
            operationId: 'op_devA_sale_oil',
            receiptNumber: 'SB-20261023-001',
            paymentMethod: 'cash',
            paymentReference: null,
            customerId: null,
            customerNameSnapshot: null,
            totalNgwee: 9200 * 4,
            totalUnits: 4,
            knownCostTotalNgwee: 7800 * 4,
            knownCostRevenueNgwee: 9200 * 4,
            missingCostLineCount: 0,
            missingCostRevenueNgwee: 0,
            note: 'Device A offline sale',
            createdAt: saleATime,
            localDate: '2026-10-23',
          },
          saleItems: [
            {
              id: 'sli_devA_1',
              saleId: 'sal_devA_1',
              productId: oil.id,
              productNameAtSale: oil.name,
              unitLabelAtSale: oil.unitLabel,
              sellingPriceAtSaleNgwee: 9200,
              costPriceAtSaleNgwee: 7800,
              quantity: 4,
              lineTotalNgwee: 9200 * 4,
              createdAt: saleATime,
            },
          ],
          stockMovements: [
            {
              id: 'stk_devA_1',
              operationId: 'op_devA_sale_oil_stk',
              productId: oil.id,
              productNameSnapshot: oil.name,
              type: 'sale',
              deltaQty: -4,
              previousQty: 5,
              newQty: 1,
              reason: 'Sale SB-20261023-001',
              relatedSaleId: 'sal_devA_1',
              createdAt: saleATime,
            },
          ],
          creditTransaction: null,
        },
      },
      {
        operationId: 'op_devA_restock_bread',
        opType: 'stock.adjust',
        createdAt: saleATime,
        payload: {
          productId: bread.id,
          mode: 'add',
          quantity: 10,
          movement: {
            id: 'stk_devA_bread',
            operationId: 'op_devA_restock_bread',
            productId: bread.id,
            productNameSnapshot: bread.name,
            type: 'restock',
            deltaQty: 10,
            previousQty: 5,
            newQty: 15,
            reason: 'Morning bakery delivery',
            relatedSaleId: null,
            createdAt: saleATime,
          },
          updatedAt: saleATime,
        },
      },
    ];

    const deviceBOps: SyncOperationEnvelope[] = [
      {
        operationId: 'op_devB_sale_oil',
        opType: 'sale.record',
        createdAt: saleBTime,
        payload: {
          sale: {
            id: 'sal_devB_1',
            operationId: 'op_devB_sale_oil',
            receiptNumber: 'SB-20261023-001', // Colliding offline receipt number!
            paymentMethod: 'mobile_money',
            paymentReference: 'Airtel Money',
            customerId: null,
            customerNameSnapshot: null,
            totalNgwee: 9200 * 3,
            totalUnits: 3,
            knownCostTotalNgwee: 7800 * 3,
            knownCostRevenueNgwee: 9200 * 3,
            missingCostLineCount: 0,
            missingCostRevenueNgwee: 0,
            note: 'Device B offline sale',
            createdAt: saleBTime,
            localDate: '2026-10-23',
          },
          saleItems: [
            {
              id: 'sli_devB_1',
              saleId: 'sal_devB_1',
              productId: oil.id,
              productNameAtSale: oil.name,
              unitLabelAtSale: oil.unitLabel,
              sellingPriceAtSaleNgwee: 9200,
              costPriceAtSaleNgwee: 7800,
              quantity: 3,
              lineTotalNgwee: 9200 * 3,
              createdAt: saleBTime,
            },
          ],
          stockMovements: [
            {
              id: 'stk_devB_1',
              operationId: 'op_devB_sale_oil_stk',
              productId: oil.id,
              productNameSnapshot: oil.name,
              type: 'sale',
              deltaQty: -3,
              previousQty: 5,
              newQty: 2,
              reason: 'Sale SB-20261023-001',
              relatedSaleId: 'sal_devB_1',
              createdAt: saleBTime,
            },
          ],
          creditTransaction: null,
        },
      },
      {
        operationId: 'op_devB_restock_bread',
        opType: 'stock.adjust',
        createdAt: saleBTime,
        payload: {
          productId: bread.id,
          mode: 'add',
          quantity: 6,
          movement: {
            id: 'stk_devB_bread',
            operationId: 'op_devB_restock_bread',
            productId: bread.id,
            productNameSnapshot: bread.name,
            type: 'restock',
            deltaQty: 6,
            previousQty: 5,
            newQty: 11,
            reason: 'Afternoon bread top-up',
            relatedSaleId: null,
            createdAt: saleBTime,
          },
          updatedAt: saleBTime,
        },
      },
    ];

    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: {
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          cookie: client.getCookieHeader(),
        },
        payload: { operations: deviceAOps },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: {
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          cookie: client.getCookieHeader(),
        },
        payload: { operations: deviceBOps },
      }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    // Pull canonical state back to local IndexedDB
    const overviewAfter = await syncWithServer({
      shop: reg.shop!,
      userId: reg.user!.id,
    });

    // 1. Both sales were preserved (ZERO lost sales!) with collision-free receipt numbers
    const syncedSales = await listSalesWithItems();
    expect(syncedSales).toHaveLength(2);
    const receipts = syncedSales.map((s) => s.receiptNumber).sort();
    expect(receipts).toEqual(['SB-20261023-001', 'SB-20261023-002']);

    // 2. Bread concurrent restocks (+10 and +6 on initial 5) combined to 21!
    //    Cooking Oil oversell (5 - 4 - 3 = -2) clamped at 0 with an explicit open stock conflict!
    const prods = await listProducts();
    const syncedBread = prods.find((p) => p.id === bread.id)!;
    const syncedOil = prods.find((p) => p.id === oil.id)!;
    expect(syncedBread.stockQty).toBe(21);
    expect(syncedOil.stockQty).toBe(0);
    expect(overviewAfter.openStockConflicts).toHaveLength(1);
    expect(overviewAfter.openStockConflicts[0]).toMatchObject({
      productId: oil.id,
      shortfallQty: 2,
      clampedQtyAfter: 0,
      status: 'open',
    });

    // 3. Owner performs physical shelf recount (`mode: 'set'`, quantity = 12) -> resolves conflict!
    await adjustProductStock({
      operationId: createId('op'),
      productId: oil.id,
      mode: 'set',
      quantity: 12,
      reason: 'Physical shelf recount including unrecorded carton',
    });
    const afterRecount = await syncWithServer({
      shop: reg.shop!,
      userId: reg.user!.id,
    });
    expect(afterRecount.openStockConflicts).toHaveLength(0);
    const recountedOil = (await listProducts()).find((p) => p.id === oil.id)!;
    expect(recountedOil.stockQty).toBe(12);
  });

  it('enforces cross-shop sync isolation and blocks clearing local device records when unsynced changes exist', async () => {
    const clientA = createFastifyCookieFetch(app);
    setApiFetchAdapter(clientA.fetchAdapter);

    // Register Shop A and sync a confidential product + customer
    const shopARes = await registerOwnerAccount({
      fullName: 'Owner Alpha',
      shopName: 'Alpha Kiosk',
      phone: '0977900001',
      password: 'AlphaSecretPassword1',
    });
    await bindLocalLedgerToShop({
      shopId: shopARes.shop!.id,
      shopName: shopARes.shop!.name,
      userId: shopARes.user!.id,
      claimExistingLocalRecords: false,
    });
    const secretProd = await createProduct({
      name: 'Alpha Confidential Stock',
      sellingPriceNgwee: 5000,
      costPriceNgwee: 4000,
      initialStockQty: 20,
    });
    await syncWithServer({
      shop: shopARes.shop!,
      userId: shopARes.user!.id,
    });

    // Record a NEW offline product in Shop A WITHOUT syncing yet
    await createProduct({
      name: 'Unsynced Offline Item',
      sellingPriceNgwee: 2500,
      costPriceNgwee: 1900,
      initialStockQty: 5,
    });

    // Attempting to clear local records without explicit force flag MUST throw UnsyncedChangesWarningError!
    await expect(
      resetLocalStoresForShopSwitchOrSignOut({
        newShop: null,
        forceDiscardUnsynced: false,
      })
    ).rejects.toThrow(UnsyncedChangesWarningError);

    // Register Shop B on a separate cookie session
    const clientB = createFastifyCookieFetch(app);
    setApiFetchAdapter(clientB.fetchAdapter);
    const shopBRes = await registerOwnerAccount({
      fullName: 'Owner Bravo',
      shopName: 'Bravo Store',
      phone: '0977900002',
      password: 'BravoSecretPassword1',
    });

    // Attempting to sync Shop B onto a browser still bound to Shop A MUST throw ShopBindingMismatchError!
    await expect(
      syncWithServer({
        shop: shopBRes.shop!,
        userId: shopBRes.user!.id,
      })
    ).rejects.toThrow(ShopBindingMismatchError);

    // Shop B attempting to pull Shop A's sync ledger via X-Shop-Id header MUST get 403 Forbidden
    const crossPull = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?afterCursor=0',
      headers: {
        cookie: clientB.getCookieHeader(),
        'x-shop-id': shopARes.shop!.id,
      },
    });
    expect(crossPull.statusCode).toBe(403);

    // Shop B's own pull contains ONLY Shop B's initial settings — zero records from Shop A!
    const ownPull = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?afterCursor=0',
      headers: {
        cookie: clientB.getCookieHeader(),
      },
    });
    expect(ownPull.statusCode).toBe(200);
    const ownEntries = ownPull.json().entries as Array<{ entityId: string }>;
    expect(ownEntries.some((e) => e.entityId === secretProd.id)).toBe(false);
  });

  it('preserves offline repayments even when synced before an offline credit sale and reconciles exact credit balances', async () => {
    const client = createFastifyCookieFetch(app);
    setApiFetchAdapter(client.fetchAdapter);

    const reg = await registerOwnerAccount({
      fullName: 'Owner Mbewe',
      shopName: 'Kabwe Credit Store',
      phone: '0977665544',
      password: 'KabweShopPassword1',
    });
    await bindLocalLedgerToShop({
      shopId: reg.shop!.id,
      shopName: reg.shop!.name,
      userId: reg.user!.id,
      claimExistingLocalRecords: false,
    });

    const mealie = await createProduct({
      name: 'Roller Meal 25kg',
      unitLabel: 'bag',
      sellingPriceNgwee: 28000, // K280.00
      costPriceNgwee: 25000,
      initialStockQty: 10,
      now: new Date('2026-10-23T08:00:00Z'),
    });
    const cust = await createCustomer({
      name: 'Mr. Phiri',
      phone: '0966001122',
      now: new Date('2026-10-23T08:05:00Z'),
    });
    await syncWithServer({ shop: reg.shop!, userId: reg.user!.id });

    // Device B syncs an offline K120.00 repayment BEFORE Device A has synced the K280.00 credit sale!
    const repayFirstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: {
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        cookie: client.getCookieHeader(),
      },
      payload: {
        operations: [
          {
            operationId: 'op_out_of_order_repay',
            opType: 'credit.repayment',
            createdAt: '2026-10-23T12:30:00.000Z',
            payload: {
              repayment: {
                id: 'crd_out_of_order_repay',
                operationId: 'op_out_of_order_repay',
                customerId: cust.id,
                customerNameSnapshot: cust.name,
                type: 'repayment',
                amountNgwee: 12000,
                paymentMethod: 'mobile_money',
                relatedSaleId: null,
                note: 'Airtel Money partial payment',
                createdAt: '2026-10-23T12:30:00.000Z',
                localDate: '2026-10-23',
              },
              customerUpdatedAt: '2026-10-23T12:30:00.000Z',
            },
          },
        ] satisfies SyncOperationEnvelope[],
      },
    });
    // Completed repayment MUST NOT be discarded!
    expect(repayFirstRes.statusCode).toBe(200);
    expect(repayFirstRes.json().results[0].status).toBe('applied');

    // Now Device A records and syncs the earlier K280.00 credit sale (recorded at 09:00 while offline)
    await recordSale({
      operationId: 'op_earlier_offline_credit_sale',
      paymentMethod: 'credit',
      customerId: cust.id,
      items: [{ productId: mealie.id, quantity: 1 }],
      now: new Date('2026-10-23T09:00:00Z'),
    });
    await syncWithServer({ shop: reg.shop!, userId: reg.user!.id });

    // Reconciled balance: K280.00 credit - K120.00 repaid = K160.00 (16000 ngwee), zero double counting!
    const [phiriSummary] = await listCustomersWithBalances();
    expect(phiriSummary.totalCreditNgwee).toBe(28000);
    expect(phiriSummary.totalRepaidNgwee).toBe(12000);
    expect(phiriSummary.outstandingBalanceNgwee).toBe(16000);

    const daySummary = await getDaySummary('2026-10-23');
    expect(daySummary.totalSalesRecordedNgwee).toBe(28000);
    expect(daySummary.creditSalesNgwee).toBe(28000);
    expect(daySummary.totalRepaymentsReceivedNgwee).toBe(12000);
    expect(daySummary.totalMoneyReceivedNgwee).toBe(12000);
    expect(daySummary.totalOutstandingCreditNgwee).toBe(16000);
  });
});
