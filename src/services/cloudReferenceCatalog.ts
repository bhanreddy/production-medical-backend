import { localDb } from '../local-db';
import { queryRaw } from '../lib/postgresDb';
import { AppError } from '../lib/appError';

const tables = ['medicines', 'suppliers', 'customers'] as const;
const cache = new Map<string, { at: number; since: string }>();
const loading = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
export function invalidateCloudReferenceCatalog(clinicId: string): void {
  generations.set(clinicId, (generations.get(clinicId) || 0) + 1);
  for (const key of cache.keys()) if (key.startsWith(`${clinicId}:`)) cache.delete(key);
}

/** Read-only cloud reference projection. Stock and financial balances remain in their owning engines. */
export async function ensureCloudReferenceCatalog(clinicId: string, organizationId: string): Promise<void> {
  const key = `${clinicId}:${organizationId}`;
  const previous = process.env.DURABLE_RUNTIME === 'postgres' ? undefined : cache.get(key);
  if (previous && Date.now() - previous.at < 30_000) return;
  const current = loading.get(key);
  if (current) return current;
  const generation = generations.get(clinicId) || 0;
  const attempt = (async () => {
    const [{ now }] = await queryRaw<{ now: string }>('SELECT CURRENT_TIMESTAMP::text AS now');
    const rowsByTable = await Promise.all(tables.map(async table => {
      const rows: Record<string, unknown>[] = [];
      let cursor = '';
      for (let page = 0; page < 100; page++) {
        const pageRows = await queryRaw<Record<string, unknown>>(`SELECT * FROM ${table}
          WHERE clinic_id = ? ${previous ? 'AND updated_at >= ?' : ''} ${cursor ? 'AND id > ?::uuid' : ''}
          ORDER BY id LIMIT 1000`, [clinicId, ...(previous ? [previous.since] : []), ...(cursor ? [cursor] : [])]);
        rows.push(...pageRows);
        if (pageRows.length < 1000) return rows;
        cursor = String(pageRows[pageRows.length - 1].id);
      }
      throw new AppError(503, 'Reference catalog is too large to load. Contact support.');
    }));
    localDb.transaction(() => {
      tables.forEach((table, index) => {
        const columns = new Set((localDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
        for (const cloud of rowsByTable[index]) {
          const id = String(cloud.id);
          const existing = localDb.prepare(`SELECT * FROM ${table} WHERE id = ? OR _local_id = ? OR _local_id = ?`).get(id, id, cloud._local_id || id) as Record<string, unknown> | undefined;
          // A pending native edit must not be overwritten by a read cache refresh.
          if (existing && Number(existing._synced) === 0) continue;
          const record: Record<string, unknown> = { ...cloud, id, _local_id: existing?._local_id || cloud._local_id || id,
            organization_id: organizationId, clinic_id: clinicId, _synced: 1, _deleted: cloud.deleted_at ? 1 : 0, _updated_at: String(cloud.updated_at || now) };
          const entries = Object.entries(record).filter(([column]) => columns.has(column)).map(([column,value]) => [column, typeof value === 'boolean' ? Number(value) : value instanceof Date ? value.toISOString() : value] as const);
          localDb.prepare(`INSERT INTO ${table} (${entries.map(([column]) => column).join(',')}) VALUES (${entries.map(() => '?').join(',')})
            ON CONFLICT(_local_id) DO UPDATE SET ${entries.filter(([column]) => column !== '_local_id').map(([column]) => `${column}=excluded.${column}`).join(',')}`).run(...entries.map(([,value]) => value));
        }
      });
    })();
    if ((generations.get(clinicId) || 0) === generation) cache.set(key, { at: Date.now(), since: now });
    if (cache.size > 1000) for (const [entry,value] of cache) if (Date.now() - value.at > 300_000) cache.delete(entry);
  })();
  loading.set(key, attempt);
  try { await attempt; } finally { if (loading.get(key) === attempt) loading.delete(key); }
}
