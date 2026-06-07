import { AppError } from '../lib/appError';
import { localMutate, queryAll, queryOne, queryRaw } from '../lib/postgresDb';

const OPEN_PO_STATUSES = ['DRAFT', 'SENT', 'PARTIAL'] as const;

const SELLABLE_BATCH_FILTER = '(is_disposed = false OR is_disposed IS NULL)';

export { SELLABLE_BATCH_FILTER };

export async function findBatchForClinic(batchId: string, clinicId: string) {
  const batch = await queryOne(
    'medicine_batches',
    '(_local_id = ? OR id = ?) AND clinic_id = ?',
    [batchId, batchId, clinicId],
  );
  return batch as Record<string, unknown> | undefined;
}

export async function assertNoOpenPurchaseOrderLines(
  clinicId: string,
  medicineId: string,
  batchNumber: string,
): Promise<void> {
  const [tableInfo] = await queryRaw<{ table_name: string | null }>(
    `SELECT to_regclass('public.purchase_orders')::text AS table_name`,
  );
  if (!tableInfo?.table_name) return;

  const openOrders = await queryAll(
    'purchase_orders',
    'clinic_id = ? AND status IN (?, ?, ?)',
    [clinicId, ...OPEN_PO_STATUSES],
  );

  for (const po of openOrders) {
    let lines: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(String((po as Record<string, unknown>).lines_json ?? '[]'));
      lines = Array.isArray(parsed) ? parsed : [];
    } catch {
      lines = [];
    }

    for (const line of lines) {
      const productId = String(line.product_id ?? line.medicine_id ?? '');
      const lineBatch = line.batch_number != null ? String(line.batch_number) : '';
      const qtyOrdered = Number(line.qty_ordered ?? 0);
      const qtyReceived = Number(line.qty_received ?? 0);
      const pending = qtyOrdered > qtyReceived;

      if (!pending || productId !== medicineId) continue;
      if (!lineBatch || lineBatch === batchNumber) {
        throw new AppError(
          409,
          'Cannot dispose this batch while open purchase order lines exist for it.',
          'OPEN_PO_LINES',
        );
      }
    }
  }
}

export async function disposeMedicineBatch(opts: {
  batchId: string;
  clinicId: string;
  userId: string;
  reason: string;
  notes?: string | null;
}) {
  const batch = await findBatchForClinic(opts.batchId, opts.clinicId);
  if (!batch) {
    throw new AppError(404, 'Batch not found for this clinic.', 'BATCH_NOT_FOUND');
  }

  if (batch.is_disposed === true || batch.is_disposed === 1) {
    throw new AppError(409, 'Batch is already disposed.', 'BATCH_ALREADY_DISPOSED');
  }

  const medicineId = String(batch.medicine_id ?? '');
  const batchNumber = String(batch.batch_number ?? '');

  await assertNoOpenPurchaseOrderLines(opts.clinicId, medicineId, batchNumber);

  const now = new Date().toISOString();
  const localId = String(batch._local_id ?? batch.id);

  const updated = await localMutate({
    table: 'medicine_batches',
    operation: 'UPDATE',
    data: {
      _local_id: localId,
      quantity_remaining: 0,
      is_disposed: true,
      disposed_at: now,
      disposed_by: opts.userId,
      disposal_reason: opts.reason,
      disposal_notes: opts.notes?.trim() || null,
    },
  });

  return updated;
}

export async function listDisposedBatches(clinicId: string) {
  const rows = await queryRaw(
    `SELECT mb.*,
            m.name AS medicine_name,
            COALESCE(u.full_name, u.phone, u.id::text) AS disposed_by_label
     FROM medicine_batches mb
     JOIN medicines m ON m.id = mb.medicine_id
     LEFT JOIN users u ON u.id = mb.disposed_by
     WHERE mb.clinic_id = ?
       AND mb.is_disposed = true
       AND mb.deleted_at IS NULL
     ORDER BY mb.disposed_at DESC NULLS LAST`,
    [clinicId],
  );
  return rows;
}
