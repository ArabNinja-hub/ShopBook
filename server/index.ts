import { buildServerApp } from './app';
import { loadServerConfig } from './config';
import { createDatabaseContext } from './db/client';
import { runMigrations } from './db/migrate';

async function main() {
  const config = loadServerConfig();
  const dbCtx = await createDatabaseContext({
    databaseUrl: config.databaseUrl,
    ssl: config.databaseSsl,
  });

  const migrationResult = await runMigrations(dbCtx);
  const app = await buildServerApp({ dbCtx, config });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down ShopBook API server...');
    await app.close();
    await dbCtx.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      engine: dbCtx.engine,
      appliedMigrations: migrationResult.applied.length,
    },
    `ShopBook API listening on http://${config.host}:${config.port}`
  );
}

main().catch((err) => {
  console.error('Failed to start ShopBook API server:', err);
  process.exit(1);
});
