import sql from '../db';
import { v4 as uuidv4 } from 'uuid';

/**
 * Standard query wrapper translating SQLite syntax to Postgres.
 */
export async function queryRaw<T = any>(queryStr: string, params: any[] = []): Promise<T[]> {
  // Convert sqlite "?" parameters to postgres "$1, $2, ..."
  let pgQuery = queryStr;
  let paramIndex = 1;
  pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);
  
  // Also clean SQLite-specific expressions if any
  pgQuery = pgQuery.replace(/_deleted\s*=\s*0/gi, 'deleted_at IS NULL');
  pgQuery = pgQuery.replace(/_deleted\s*=\s*1/gi, 'deleted_at IS NOT NULL');
  
  return await sql.unsafe(pgQuery, params) as T[];
}

export async function queryAll<T = any>(table: string, whereClause: string = '', params: any[] = []): Promise<T[]> {
  let queryStr = `SELECT * FROM ${table} WHERE _deleted = 0`;
  if (whereClause) {
    queryStr += ` AND (${whereClause})`;
  }
  return await queryRaw<T>(queryStr, params);
}

export async function queryOne<T = any>(table: string, whereClause: string = '', params: any[] = []): Promise<T | undefined> {
  const rows = await queryAll<T>(table, whereClause, params);
  return rows[0];
}

export async function queryCount(table: string, whereClause: string = '', params: any[] = []): Promise<number> {
  let queryStr = `SELECT COUNT(*) as cnt FROM ${table} WHERE _deleted = 0`;
  if (whereClause) {
    queryStr += ` AND (${whereClause})`;
  }
  const rows = await queryRaw<any>(queryStr, params);
  return Number(rows[0]?.cnt || 0);
}

export async function localMutate({ table, operation, data }: { table: string; operation: 'INSERT' | 'UPDATE' | 'DELETE'; data: Record<string, any> }) {
  const localId = data._local_id || data.id || uuidv4();
  const now = new Date().toISOString();
  
  if (operation === 'DELETE') {
    await sql`
      UPDATE ${sql(table)}
      SET deleted_at = ${now}, updated_at = ${now}
      WHERE _local_id = ${localId}
    `;
    return { _local_id: localId, _deleted: 1, deleted_at: now };
  }
  
  const payload: any = { ...data };
  delete payload._synced;
  delete payload._updated_at;
  delete payload._deleted;
  
  payload._local_id = localId;
  payload.updated_at = now;
  
  if (operation === 'INSERT') {
    const [inserted] = await sql<any[]>`
      INSERT INTO ${sql(table)} ${sql(payload)}
      RETURNING *
    `;
    return inserted;
  } else {
    // operation === 'UPDATE'
    const updatePayload = { ...payload };
    delete updatePayload._local_id; // Preserve primary identifier key column
    if (updatePayload.id === localId) {
      delete updatePayload.id;
    }
    
    const [updated] = await sql<any[]>`
      UPDATE ${sql(table)}
      SET ${sql(updatePayload)}
      WHERE _local_id = ${localId}
      RETURNING *
    `;
    return updated;
  }
}
