import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseContext } from './client';

export interface AppliedMigrationRecord {
  id: string;
  checksumSha256: string;
  appliedAt: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.join(currentDir, 'migrations');

function computeSha256(content: string): string {
  // Normalize CRLF -> LF so Windows PowerShell and Linux compute identical migration checksums
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Applies versioned PostgreSQL SQL migrations idempotently with SHA-256 tamper detection.
 * Every unapplied `.sql` file runs inside an explicit `BEGIN ... COMMIT` transaction.
 */
export async function runMigrations(
  dbCtx: DatabaseContext,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): Promise<{ applied: string[]; skipped: string[] }> {
  await dbCtx.execRawSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const existingRows = await dbCtx.queryRaw<{
    id: string;
    checksum_sha256: string;
  }>('SELECT id, checksum_sha256 FROM schema_migrations ORDER BY id ASC');

  const appliedMap = new Map<string, string>();
  for (const row of existingRows) {
    appliedMap.set(row.id, row.checksum_sha256);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    const fullPath = path.join(migrationsDir, filename);
    const sqlContent = fs.readFileSync(fullPath, 'utf8');
    const checksum = computeSha256(sqlContent);

    const existingChecksum = appliedMap.get(filename);
    if (existingChecksum) {
      if (existingChecksum !== checksum) {
        throw new Error(
          `Migration checksum mismatch for "${filename}". Applied migrations must never be modified after execution.`
        );
      }
      skipped.push(filename);
      continue;
    }

    const escapedId = filename.replace(/'/g, "''");
    const escapedHash = checksum.replace(/'/g, "''");
    await dbCtx.execRawSql(`
      BEGIN;
      ${sqlContent}
      INSERT INTO schema_migrations (id, checksum_sha256)
      VALUES ('${escapedId}', '${escapedHash}');
      COMMIT;
    `);
    applied.push(filename);
  }

  return { applied, skipped };
}
