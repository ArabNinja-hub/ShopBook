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
  StockConflictNotice,
  SyncOperationPayloadMap,
  SyncOpType,
} from '../shared/syncTypes';

/**
 * Persistent Local Database Layer (IndexedDB).
 *
 * Milestone 2 Non-Destructive Schema Upgrade:
 * - Preserves `DB_NAME = 'shopbook_local_v1'` so existing Milestone 1 shops keep 100% of
 *   their locally recorded products, sales, stock movements, customers, and credit ledgers.
 * - Upgrades `DB_VERSION` from 1 -> 2, adding `syncOutbox` (atomic FIFO queue) and
 *   `syncState` (cursor, shop binding, sync timestamps, and multi-device stock conflict notices).
 */

export const DB_NAME = 'shopbook_local_v1';
export const DB_VERSION = 2;

export const STORES = {
  meta: 'meta',
  products: 'products',
  sales: 'sales',
  saleItems: 'saleItems',
  stockMovements: 'stockMovements',
  customers: 'customers',
  creditTransactions: 'creditTransactions',
  syncOutbox: 'syncOutbox',
  syncState: 'syncState',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export interface SyncOutboxRecord<K extends SyncOpType = SyncOpType> {
  /** Auto-incremented monotonic local queue sequence */
  seq?: number;
  operationId: string;
  opType: K;
  createdAt: string;
  payload: SyncOperationPayloadMap[K];
  attempts: number;
  lastError: string | null;
}

export interface LocalSyncStateRecord {
  key: 'accountSync';
  boundShopId: string | null;
  boundShopName: string | null;
  boundUserId: string | null;
  cursor: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  openStockConflicts: StockConflictNotice[];
}

export interface StoreValueMap {
  meta: ShopSettings;
  products: Product;
  sales: Sale;
  saleItems: SaleItem;
  stockMovements: StockMovement;
  customers: Customer;
  creditTransactions: CreditTransaction;
  syncOutbox: SyncOutboxRecord;
  syncState: LocalSyncStateRecord;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Opens (or non-destructively upgrades v1 -> v2) the ShopBook IndexedDB database.
 */
export function openShopDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(
        new Error(
          'IndexedDB is not available in this browser environment. Please use a standard mobile or desktop browser.'
        )
      );
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(STORES.products)) {
        const productStore = db.createObjectStore(STORES.products, { keyPath: 'id' });
        productStore.createIndex('by_name', 'name', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.sales)) {
        const salesStore = db.createObjectStore(STORES.sales, { keyPath: 'id' });
        salesStore.createIndex('by_operationId', 'operationId', { unique: true });
        salesStore.createIndex('by_localDate', 'localDate', { unique: false });
        salesStore.createIndex('by_customerId', 'customerId', { unique: false });
        salesStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.saleItems)) {
        const itemsStore = db.createObjectStore(STORES.saleItems, { keyPath: 'id' });
        itemsStore.createIndex('by_saleId', 'saleId', { unique: false });
        itemsStore.createIndex('by_productId', 'productId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.stockMovements)) {
        const moveStore = db.createObjectStore(STORES.stockMovements, { keyPath: 'id' });
        moveStore.createIndex('by_operationId', 'operationId', { unique: true });
        moveStore.createIndex('by_productId', 'productId', { unique: false });
        moveStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.customers)) {
        const customerStore = db.createObjectStore(STORES.customers, { keyPath: 'id' });
        customerStore.createIndex('by_name', 'name', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.creditTransactions)) {
        const creditStore = db.createObjectStore(STORES.creditTransactions, {
          keyPath: 'id',
        });
        creditStore.createIndex('by_operationId', 'operationId', { unique: true });
        creditStore.createIndex('by_customerId', 'customerId', { unique: false });
        creditStore.createIndex('by_localDate', 'localDate', { unique: false });
        creditStore.createIndex('by_createdAt', 'createdAt', { unique: false });
      }

      // Milestone 2 v2 stores (added non-destructively without touching v1 stores)
      if (!db.objectStoreNames.contains(STORES.syncOutbox)) {
        const outboxStore = db.createObjectStore(STORES.syncOutbox, {
          keyPath: 'seq',
          autoIncrement: true,
        });
        outboxStore.createIndex('by_operationId', 'operationId', { unique: true });
      }

      if (!db.objectStoreNames.contains(STORES.syncState)) {
        db.createObjectStore(STORES.syncState, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open local ShopBook database.'));
    };
  });

  return dbPromise;
}

/**
 * Converts a native IDBRequest into a Promise while keeping the active transaction alive.
 */
export function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Database request failed.'));
  });
}

/**
 * Typed store helpers scoped to a single IndexedDB transaction.
 */
export interface TxContext {
  tx: IDBTransaction;
  store<K extends StoreName>(name: K): IDBObjectStore;
  get<K extends StoreName>(
    name: K,
    key: IDBValidKey
  ): Promise<StoreValueMap[K] | undefined>;
  getAll<K extends StoreName>(name: K): Promise<StoreValueMap[K][]>;
  getAllByIndex<K extends StoreName>(
    name: K,
    indexName: string,
    query: IDBValidKey
  ): Promise<StoreValueMap[K][]>;
  getOneByIndex<K extends StoreName>(
    name: K,
    indexName: string,
    query: IDBValidKey
  ): Promise<StoreValueMap[K] | undefined>;
  put<K extends StoreName>(name: K, value: StoreValueMap[K]): Promise<void>;
  add<K extends StoreName>(name: K, value: StoreValueMap[K]): Promise<void>;
  delete<K extends StoreName>(name: K, key: IDBValidKey): Promise<void>;
  clear<K extends StoreName>(name: K): Promise<void>;
}

function buildTxContext(tx: IDBTransaction): TxContext {
  return {
    tx,
    store(name) {
      return tx.objectStore(name);
    },
    get(name, key) {
      return reqToPromise(tx.objectStore(name).get(key));
    },
    getAll(name) {
      return reqToPromise(tx.objectStore(name).getAll());
    },
    getAllByIndex(name, indexName, query) {
      return reqToPromise(tx.objectStore(name).index(indexName).getAll(query));
    },
    getOneByIndex(name, indexName, query) {
      return reqToPromise(tx.objectStore(name).index(indexName).get(query));
    },
    async put(name, value) {
      await reqToPromise(tx.objectStore(name).put(value));
    },
    async add(name, value) {
      await reqToPromise(tx.objectStore(name).add(value));
    },
    async delete(name, key) {
      await reqToPromise(tx.objectStore(name).delete(key));
    },
    async clear(name) {
      await reqToPromise(tx.objectStore(name).clear());
    },
  };
}

/**
 * Enqueues an idempotent sync outbox operation inside the caller's active `readwrite` transaction.
 * Because this runs in the same IndexedDB transaction as the local write, a mutation and its
 * outbox record are guaranteed to commit or roll back atomically together.
 */
export async function enqueueOutboxInTx<K extends SyncOpType>(
  ctx: TxContext,
  entry: {
    operationId: string;
    opType: K;
    createdAt: string;
    payload: SyncOperationPayloadMap[K];
  }
): Promise<void> {
  const existing = await ctx.getOneByIndex(
    STORES.syncOutbox,
    'by_operationId',
    entry.operationId
  );
  if (existing) {
    return;
  }
  await ctx.add(STORES.syncOutbox, {
    operationId: entry.operationId,
    opType: entry.opType,
    createdAt: entry.createdAt,
    payload: entry.payload,
    attempts: 0,
    lastError: null,
  });
}

/**
 * Runs an atomic transaction across one or more stores.
 */
export async function runTransaction<T>(
  storeNames: StoreName[],
  mode: IDBTransactionMode,
  worker: (ctx: TxContext) => Promise<T>
): Promise<T> {
  const db = await openShopDatabase();

  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const ctx = buildTxContext(tx);

    let workerResult: T;
    let workerFinished = false;
    let workerError: unknown = null;

    tx.oncomplete = () => {
      if (workerError !== null) {
        reject(workerError);
      } else if (workerFinished) {
        resolve(workerResult);
      } else {
        reject(new Error('Transaction finished before all operations completed.'));
      }
    };

    tx.onabort = () => {
      reject(workerError ?? tx.error ?? new Error('Database transaction was aborted.'));
    };

    tx.onerror = () => {
      if (workerError === null) {
        workerError = tx.error ?? new Error('Database transaction error.');
      }
    };

    worker(ctx)
      .then((res) => {
        workerResult = res;
        workerFinished = true;
      })
      .catch((err) => {
        workerError = err;
        try {
          tx.abort();
        } catch {
          // Transaction may already be aborting due to a constraint error.
        }
      });
  });
}

/**
 * Closes the active IndexedDB connection without deleting stored data.
 */
export async function closeShopDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

/**
 * Closes and deletes the entire local database (used by automated tests to start clean).
 */
export async function resetDatabaseForTests(): Promise<void> {
  await closeShopDatabase();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
