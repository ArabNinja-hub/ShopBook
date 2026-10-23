import fs from 'node:fs';
import path from 'node:path';
import { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppDatabase = PgDatabase<any, typeof schema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppTransaction = PgTransaction<any, typeof schema, any>;

export interface DatabaseContext {
  readonly engine: 'node-postgres' | 'pglite';
  readonly db: AppDatabase;
  execRawSql(sqlText: string): Promise<void>;
  queryRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    sqlText: string,
    params?: unknown[]
  ): Promise<T[]>;
  runInTransaction<T>(fn: (tx: AppTransaction) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Simple FIFO async mutex used ONLY for single-connection embedded PGlite instances
 * so concurrent `Promise.all([runInTransaction(...), runInTransaction(...)])` calls
 * never interleave raw `BEGIN` statements on a single session.
 * Real `node-postgres` pools run concurrently across separate pooled connections.
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.queue;
    this.queue = prev.then(() => next);
    await prev;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export async function createDatabaseContext(options: {
  databaseUrl: string;
  ssl?: boolean;
}): Promise<DatabaseContext> {
  const { databaseUrl, ssl = false } = options;

  if (
    databaseUrl.startsWith('postgres://') ||
    databaseUrl.startsWith('postgresql://')
  ) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });

    const db = drizzleNodePg(pool, { schema }) as unknown as AppDatabase;

    return {
      engine: 'node-postgres',
      db,
      async execRawSql(sqlText: string): Promise<void> {
        const client = await pool.connect();
        try {
          await client.query(sqlText);
        } finally {
          client.release();
        }
      },
      async queryRaw<T extends Record<string, unknown>>(
        sqlText: string,
        params: unknown[] = []
      ): Promise<T[]> {
        const res = await pool.query(sqlText, params);
        return res.rows as T[];
      },
      async runInTransaction<T>(
        fn: (tx: AppTransaction) => Promise<T>
      ): Promise<T> {
        return db.transaction(async (tx) => fn(tx as unknown as AppTransaction));
      },
      async ping(): Promise<boolean> {
        const res = await pool.query('SELECT 1 AS ok');
        return res.rowCount === 1;
      },
      async close(): Promise<void> {
        await pool.end();
      },
    };
  }

  if (databaseUrl.startsWith('pglite://')) {
    const target = databaseUrl.slice('pglite://'.length).trim();
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');

    let pgliteInstance: InstanceType<typeof PGlite>;
    if (!target || target === 'memory') {
      pgliteInstance = new PGlite();
    } else {
      const resolvedDir = path.resolve(process.cwd(), target);
      fs.mkdirSync(path.dirname(resolvedDir), { recursive: true });
      pgliteInstance = new PGlite(resolvedDir);
    }

    await pgliteInstance.waitReady;
    const db = drizzlePglite(pgliteInstance, { schema }) as unknown as AppDatabase;
    const mutex = new AsyncMutex();

    return {
      engine: 'pglite',
      db,
      async execRawSql(sqlText: string): Promise<void> {
        await mutex.runExclusive(async () => {
          await pgliteInstance.exec(sqlText);
        });
      },
      async queryRaw<T extends Record<string, unknown>>(
        sqlText: string,
        params: unknown[] = []
      ): Promise<T[]> {
        return mutex.runExclusive(async () => {
          const res = await pgliteInstance.query<T>(sqlText, params);
          return res.rows;
        });
      },
      async runInTransaction<T>(
        fn: (tx: AppTransaction) => Promise<T>
      ): Promise<T> {
        return mutex.runExclusive(async () =>
          db.transaction(async (tx) => fn(tx as unknown as AppTransaction))
        );
      },
      async ping(): Promise<boolean> {
        const res = await pgliteInstance.query('SELECT 1 AS ok');
        return res.rows.length === 1;
      },
      async close(): Promise<void> {
        await pgliteInstance.close();
      },
    };
  }

  throw new Error(
    `Unsupported DATABASE_URL scheme: "${databaseUrl}". Expected postgresql://... or pglite://...`
  );
}
