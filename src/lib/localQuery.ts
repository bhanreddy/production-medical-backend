import { localDb } from '../local-db';

export function queryAll<T = Record<string, any>>(
  table: string,
  where: string = '',
  params: any[] = []
): T[] {
  const whereClause = where ? `WHERE _deleted=0 AND (${where})` : 'WHERE _deleted=0';
  return localDb.prepare(`SELECT * FROM ${table} ${whereClause}`).all(...params) as T[];
}

export function queryOne<T = Record<string, any>>(
  table: string,
  where: string,
  params: any[] = []
): T | undefined {
  return localDb.prepare(
    `SELECT * FROM ${table} WHERE _deleted=0 AND (${where})`
  ).get(...params) as T | undefined;
}

export function queryRaw<T = Record<string, any>>(
  sql: string,
  params: any[] = []
): T[] {
  return localDb.prepare(sql).all(...params) as T[];
}

export function queryCount(
  table: string,
  where: string = '',
  params: any[] = []
): number {
  const whereClause = where ? `WHERE _deleted=0 AND (${where})` : 'WHERE _deleted=0';
  const row = localDb.prepare(
    `SELECT COUNT(*) as cnt FROM ${table} ${whereClause}`
  ).get(...params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
