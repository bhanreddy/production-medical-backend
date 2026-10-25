import defaultSql from "../db";
const sql = defaultSql;
import { AsyncLocalStorage } from "node:async_hooks";

const transactions = new AsyncLocalStorage<{
  executor: typeof sql;
  afterCommit: Array<() => void>;
  beforeCommit: Array<() => void | Promise<void>>;
}>();
export async function withPostgresTransaction<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (transactions.getStore()) return operation();
  const callbacks: Array<() => void> = [];
  const beforeCommit: Array<() => void | Promise<void>> = [];
  const result = await sql.begin(async (tx) =>
    transactions.run(
      { executor: tx as unknown as typeof sql, afterCommit: callbacks, beforeCommit },
      async () => {
        const value = await operation();
        for (const callback of beforeCommit) await callback();
        return value;
      },
    ),
  );
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      console.error(
        "Committed transaction: local projection update failed",
        error,
      );
    }
  }
  return result as T;
}

/** Local projections must join the durable checkpoint before its SQL transaction commits. */
export function beforePostgresCommit(callback: () => void | Promise<void>): void {
  const transaction = transactions.getStore();
  if (transaction) transaction.beforeCommit.push(callback);
  else void callback();
}

/** Native PostgreSQL parameters, including bytea, without SQLite syntax rewriting. */
export async function postgresQuery<T = Record<string, any>>(query: string, params: any[] = []): Promise<T[]> {
  return await (transactions.getStore()?.executor || sql).unsafe(query, params) as unknown as T[];
}
export function afterPostgresCommit(callback: () => void): void {
  const transaction = transactions.getStore();
  if (transaction) transaction.afterCommit.push(callback);
  else callback();
}

import { v4 as uuidv4 } from "uuid";

/**
 * Standard query wrapper translating SQLite syntax to Postgres.
 */
export async function queryRaw<T = any>(
  queryStr: string,
  params: any[] = [],
): Promise<T[]> {
  // Convert sqlite "?" parameters to postgres "$1, $2, ..."
  let pgQuery = queryStr;
  let paramIndex = 1;
  pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);

  // Also clean SQLite-specific expressions if any
  pgQuery = pgQuery.replace(/_deleted\s*=\s*0/gi, "deleted_at IS NULL");
  pgQuery = pgQuery.replace(/_deleted\s*=\s*1/gi, "deleted_at IS NOT NULL");

  return (await (transactions.getStore()?.executor || sql).unsafe(
    pgQuery,
    params,
  )) as T[];
}

export async function queryAll<T = any>(
  table: string,
  whereClause: string = "",
  params: any[] = [],
): Promise<T[]> {
  let queryStr = `SELECT * FROM ${table} WHERE _deleted = 0`;
  if (whereClause) {
    queryStr += ` AND (${whereClause})`;
  }
  if (
    transactions.getStore() &&
    ["medicine_batches", "customers", "suppliers"].includes(table)
  )
    queryStr += " ORDER BY id FOR UPDATE";
  return await queryRaw<T>(queryStr, params);
}

export async function queryOne<T = any>(
  table: string,
  whereClause: string = "",
  params: any[] = [],
): Promise<T | undefined> {
  const rows = await queryAll<T>(table, whereClause, params);
  return rows[0];
}

export async function queryCount(
  table: string,
  whereClause: string = "",
  params: any[] = [],
): Promise<number> {
  let queryStr = `SELECT COUNT(*) as cnt FROM ${table} WHERE _deleted = 0`;
  if (whereClause) {
    queryStr += ` AND (${whereClause})`;
  }
  const rows = await queryRaw<any>(queryStr, params);
  return Number(rows[0]?.cnt || 0);
}

export async function localMutate({
  table,
  operation,
  data,
}: {
  table: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  data: Record<string, any>;
}) {
  const sql = transactions.getStore()?.executor || defaultSql;
  const localId = data._local_id || data.id || uuidv4();
  const now = new Date().toISOString();
  const uuidId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(localId),
    )
      ? localId
      : null;

  if (operation === "DELETE") {
    await sql`
      UPDATE ${sql(table)}
      SET deleted_at = ${now}, updated_at = ${now}
      WHERE _local_id = ${localId} OR id = ${uuidId}
    `;
    return { _local_id: localId, _deleted: 1, deleted_at: now };
  }

  const payload: any = { ...data };
  for (const key of Object.keys(payload))
    if (payload[key] === undefined) delete payload[key];
  delete payload._synced;
  delete payload._updated_at;
  delete payload._deleted;

  payload._local_id = localId;
  payload.updated_at = now;

  if (operation === "INSERT") {
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
      WHERE _local_id = ${localId} OR id = ${uuidId}
      RETURNING *
    `;
    return updated;
  }
}

/** One round trip for a homogeneous set of rows, using the current transaction. */
export async function localInsertMany(table: string, rows: Record<string, any>[]) {
  if (!rows.length) return [];
  const executor = transactions.getStore()?.executor || defaultSql;
  const now = new Date().toISOString();
  const payloads = rows.map(row => {
    const payload: Record<string, any> = { ...row, _local_id: row._local_id || row.id || uuidv4(), updated_at: now };
    for (const key of Object.keys(payload))
      if (payload[key] === undefined || ['_synced', '_updated_at', '_deleted'].includes(key)) delete payload[key];
    return payload;
  });
  const inserted = await executor<any[]>`
    INSERT INTO ${executor(table)} ${executor(payloads)} RETURNING *
  `;
  // RETURNING ordering is not a contract. Keep invoice lines in cart order.
  const byLocalId = new Map(inserted.map(row => [row._local_id, row]));
  return payloads.map(row => byLocalId.get(row._local_id));
}
