import { queryRaw } from '../lib/postgresDb';

/** Read validation inputs in two queries instead of two round trips per cart line. */
export async function loadSaleReferences(
  items: Array<{ medicine_id: string; batch_id: string }>,
  clinicId: string,
) {
  const medicineIds = [...new Set(items.map(item => item.medicine_id))];
  const batchIds = [...new Set(items.map(item => item.batch_id))];
  const read = async (table: 'medicines' | 'medicine_batches', ids: string[]) => {
    const mapped = new Map<string, any>();
    if (ids.length === 0) return mapped;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await queryRaw(
      `SELECT * FROM ${table} WHERE clinic_id = ? AND deleted_at IS NULL
       AND (id IN (${placeholders}) OR _local_id IN (${placeholders})) ORDER BY id${table === 'medicine_batches' ? ' FOR UPDATE' : ''}`,
      [clinicId, ...ids, ...ids],
    );
    for (const row of rows) {
      if (row.id) mapped.set(row.id, row);
      if (row._local_id) mapped.set(row._local_id, row);
    }
    return mapped;
  };
  const [medicines, batches] = await Promise.all([
    read('medicines', medicineIds), read('medicine_batches', batchIds),
  ]);
  return { medicines, batches };
}
