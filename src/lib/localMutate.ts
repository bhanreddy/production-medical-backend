import { v4 as uuidv4 } from 'uuid';
import { localDb } from '../local-db';

type Operation = 'INSERT' | 'UPDATE' | 'DELETE';

interface MutateOptions {
  table: string;
  operation: Operation;
  data: Record<string, any>;
}

export function localMutate({ table, operation, data }: MutateOptions) {
  const localId: string = data._local_id ?? data.id ?? uuidv4();
  const now = new Date().toISOString();
  const record = { _deleted: 0, ...data, _local_id: localId, _synced: 0, _updated_at: now };

  if (operation === 'DELETE') {
    localDb.prepare(
      `UPDATE ${table} SET _deleted=1, _synced=0, _updated_at=? WHERE _local_id=? OR id=?`
    ).run(now, localId, localId);
  } else if (operation === 'UPDATE') {
    let existing: any = null;
    try {
      existing = localDb.prepare(`SELECT * FROM ${table} WHERE _local_id=? OR id=?`).get(localId, localId);
    } catch {}

    const merged = { _deleted: 0, ...(existing || {}), ...data, _local_id: localId, _synced: 0, _updated_at: now };
    const cols = Object.keys(merged).join(', ');
    const placeholders = Object.keys(merged).map(() => '?').join(', ');

    localDb.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
    ).run(...Object.values(merged));

    localDb.prepare(
      `INSERT OR REPLACE INTO sync_queue(id, table_name, record_id, operation, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), table, localId, operation, JSON.stringify(merged), now);

    return merged;
  } else {
    const cols = Object.keys(record).join(', ');
    const placeholders = Object.keys(record).map(() => '?').join(', ');
    localDb.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
    ).run(...Object.values(record));
  }

  localDb.prepare(
    `INSERT OR REPLACE INTO sync_queue(id, table_name, record_id, operation, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), table, localId, operation, JSON.stringify(record), now);

  return record;
}
