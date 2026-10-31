import fs from 'fs';
import path from 'path';
import sql from '../db';
import { logger } from './logger';

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

/** Apply idempotent SQL migrations from backend/migrations (sorted by filename). */
export async function runPendingMigrations(): Promise<void> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn('Migrations directory not found', { dir: MIGRATIONS_DIR });
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  // A shared transaction lock keeps concurrent replicas from applying the same
  // migration. SQL changes and their ledger entries commit or roll back together.
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('medical-pos:migrations', 0))`;
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS _app_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await tx<{ name: string }[]>`SELECT name FROM _app_migrations`;
    const appliedSet = new Set(applied.map(row => row.name));
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      try {
        await tx.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await tx`INSERT INTO _app_migrations (name) VALUES (${file})`;
        logger.info('Migration prepared', { file });
      } catch (error) {
        logger.error('Migration failed', { file, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  });
}
