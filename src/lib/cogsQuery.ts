import { queryRaw } from './postgresDb';

/** Build COGS line query: qty sold × cost from purchase inward (fallback: batch purchase_price). */
export function buildCogsLineQuery(dateFrom?: string, dateTo?: string, clinicId?: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let dateFilter = '';
  if (clinicId) {
    dateFilter += ' AND s.clinic_id=?';
    params.push(clinicId);
  }
  if (dateFrom) {
    dateFilter += ' AND s.created_at>=?';
    params.push(dateFrom);
  }
  if (dateTo) {
    dateFilter += ' AND s.created_at<=?';
    params.push(dateTo);
  }

  const sql = `
    SELECT si.quantity as qty,
      COALESCE(
        NULLIF(latest_pi.purchase_price, 0),
        NULLIF(mb.purchase_price, 0),
        0
      ) as pp
    FROM sale_items si
    INNER JOIN sales s ON s.id::text = si.sale_id::text
    INNER JOIN medicine_batches mb ON mb.id::text = si.batch_id::text
    LEFT JOIN LATERAL (
      SELECT pi.purchase_price
      FROM purchase_items pi
      WHERE pi.deleted_at IS NULL
        AND pi.medicine_id::text = si.medicine_id::text
        AND pi.batch_number = mb.batch_number
      ORDER BY pi.updated_at DESC NULLS LAST, pi.id DESC
      LIMIT 1
    ) latest_pi ON true
    WHERE si.deleted_at IS NULL AND s.deleted_at IS NULL
      AND COALESCE(s.is_return, false) = false
      AND si.batch_id IS NOT NULL
      ${dateFilter}
  `;

  return { sql, params };
}

export async function computeCogs(from?: string, to?: string, clinicId?: string): Promise<number> {
  const { sql, params } = buildCogsLineQuery(from, to, clinicId);
  const rows = await queryRaw<{ qty: number; pp: number }>(sql, params);
  return rows.reduce((acc, row) => acc + Number(row.qty) * Number(row.pp), 0);
}
