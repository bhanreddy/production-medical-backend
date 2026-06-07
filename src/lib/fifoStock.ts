import { AppError } from './appError';

export type FifoBatchRow = {
  id: string;
  medicine_id: string;
  expiry_date: string;
  quantity_remaining: number;
};

export function isBatchExpired(expiryDate: string, asOf: Date = new Date()): boolean {
  const d = new Date(expiryDate);
  const day = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  return d < day;
}

/** Non-expired batches with stock, earliest expiry first (FIFO). */
export function sortBatchesForFifo(batches: FifoBatchRow[], asOf: Date = new Date()): FifoBatchRow[] {
  return [...batches]
    .filter((b) => b.quantity_remaining > 0 && !isBatchExpired(b.expiry_date, asOf))
    .sort((a, b) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime());
}

export function planFifoDeductions(
  batches: FifoBatchRow[],
  quantity: number,
  asOf: Date = new Date()
): Array<{ batch_id: string; quantity: number }> {
  if (quantity <= 0) {
    throw new AppError(400, 'Quantity must be positive', 'INVALID_QUANTITY');
  }
  const sorted = sortBatchesForFifo(batches, asOf);
  let remaining = quantity;
  const out: Array<{ batch_id: string; quantity: number }> = [];
  for (const b of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.quantity_remaining);
    out.push({ batch_id: b.id, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new AppError(
      400,
      `Insufficient stock for medicine. Requested: ${quantity}, available (non-expired): ${quantity - remaining}`,
      'INSUFFICIENT_STOCK'
    );
  }
  return out;
}
