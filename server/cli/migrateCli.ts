import { loadServerConfig } from '../config';
import { createDatabaseContext } from '../db/client';
import { runMigrations } from '../db/migrate';

async function main() {
  const config = loadServerConfig();
  const dbCtx = await createDatabaseContext({
    databaseUrl: config.databaseUrl,
    ssl: config.databaseSsl,
  });
  try {
    const result = await runMigrations(dbCtx);
    console.log(
      `Migrations complete (${dbCtx.engine}). Applied: ${result.applied.length}, Already up-to-date: ${result.skipped.length}.`
    );
  } finally {
    await dbCtx.close();
  }
}

main().catch((err) => {
  console.error('Database migration failed:', err);
  process.exit(1);
});
