import { loadServerConfig } from '../config';
import { createDatabaseContext } from '../db/client';
import { runMigrations } from '../db/migrate';
import { issueAdminPasswordResetCode } from '../services/authService';

function parseIdentifierArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (
      (argv[i] === '--identifier' || argv[i] === '-i') &&
      typeof argv[i + 1] === 'string'
    ) {
      return argv[i + 1];
    }
    if (!argv[i].startsWith('-')) {
      return argv[i];
    }
  }
  return null;
}

async function main() {
  const identifier = parseIdentifierArg(process.argv.slice(2));
  if (!identifier) {
    console.error(
      'Usage: npm run admin:issue-reset -- --identifier <phone-or-email>'
    );
    process.exit(1);
  }

  const config = loadServerConfig();
  const dbCtx = await createDatabaseContext({
    databaseUrl: config.databaseUrl,
    ssl: config.databaseSsl,
  });

  try {
    await runMigrations(dbCtx);
    const issued = await issueAdminPasswordResetCode(dbCtx, identifier, 30);
    console.log('------------------------------------------------------------');
    console.log('ShopBook Pilot Account Recovery — Single-Use Reset Code');
    console.log(`Account:     ${issued.normalizedIdentifier}`);
    console.log(`Reset Code:  ${issued.rawResetCode}`);
    console.log(`Expires At:  ${issued.expiresAt.toISOString()} (30 minutes)`);
    console.log('------------------------------------------------------------');
    console.log(
      'Provide this single-use code ONLY to the verified shop owner. It expires in 30 minutes and revokes old sessions once used.'
    );
  } finally {
    await dbCtx.close();
  }
}

main().catch((err) => {
  console.error(
    'Failed to issue reset code:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
