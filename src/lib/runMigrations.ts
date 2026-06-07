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

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _app_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = await sql<{ name: string }[]>`SELECT name FROM _app_migrations`;
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const filePath = path.join(MIGRATIONS_DIR, file);
    const contents = fs.readFileSync(filePath, 'utf8');
    try {
      await sql.unsafe(contents);
      await sql`INSERT INTO _app_migrations (name) VALUES (${file})`;
      logger.info('Migration applied', { file });
    } catch (err: any) {
      logger.error('Migration failed', { file, message: err?.message });
      throw err;
    }
  }
}
