import { z } from 'zod';

/* ─── Push Schema ─────────────────────────────────────── */

const syncOperationSchema = z.object({
  op: z.enum(['INSERT', 'UPDATE', 'DELETE']),
  payload: z.record(z.unknown()),
  queue_id: z.string().min(1),
});

const syncBatchSchema = z.object({
  table: z.string().min(1),
  operations: z.array(syncOperationSchema).min(1),
});

export const pushBodySchema = z.object({
  batches: z.array(syncBatchSchema).min(1).max(50),
});

export type PushBody = z.infer<typeof pushBodySchema>;

/* ─── Pull Query Schema ──────────────────────────────── */

export const pullQuerySchema = z.object({
  since: z.string().min(1),    // ISO timestamp
  tables: z.string().min(1),   // comma-separated table names
});

export type PullQuery = z.infer<typeof pullQuerySchema>;

/* ─── Verify Schema ──────────────────────────────────── */

export const verifyBodySchema = z.object({
  local_ids: z.array(z.string().min(1)).min(1).max(500),
});

export type VerifyBody = z.infer<typeof verifyBodySchema>;

/* ─── Allowed Tables ─────────────────────────────────── */

export const SYNCABLE_TABLES = [
  'suppliers',
  'customers',
  'medicines',
  'medicine_batches',
  'purchases',
  'purchase_items',
  'sales',
  'sale_items',
  'expenses',
  'shortbook',
  'refill_reminders',
] as const;

export type SyncableTable = (typeof SYNCABLE_TABLES)[number];

export function isValidSyncTable(table: string): table is SyncableTable {
  return (SYNCABLE_TABLES as readonly string[]).includes(table);
}

/* ─── Critical Tables (require server-side validation before commit) ── */

export const CRITICAL_TABLES = [
  'sales',
  'sale_items',
  'purchases',
  'purchase_items',
] as const;

export function isCriticalTable(table: string): boolean {
  return (CRITICAL_TABLES as readonly string[]).includes(table);
}

/* ─── Billing Validation ─────────────────────────────── */

/** Lightweight server-side validation for sales/billing payloads. */
export function validateBillingPayload(
  table: string,
  payload: Record<string, unknown>,
): { valid: boolean; error?: string } {
  if (table === 'sales') {
    const net = Number(payload.net_amount ?? 0);
    const subtotal = Number(payload.subtotal ?? 0);
    const gst = Number(payload.gst_amount ?? 0);
    const discount = Number(payload.discount ?? 0);

    if (net < 0) return { valid: false, error: 'net_amount cannot be negative' };
    if (subtotal < 0) return { valid: false, error: 'subtotal cannot be negative' };

    // Basic GST sanity check
    const expectedNet = subtotal - discount + gst;
    if (Math.abs(net - expectedNet) > 1) {
      return {
        valid: false,
        error: `net_amount mismatch: expected ~${expectedNet.toFixed(2)}, got ${net}`,
      };
    }
  }

  if (table === 'sale_items') {
    const qty = Number(payload.quantity ?? 0);
    const mrp = Number(payload.mrp ?? 0);
    if (qty <= 0) return { valid: false, error: 'quantity must be positive' };
    if (mrp <= 0) return { valid: false, error: 'mrp must be positive' };
  }

  if (table === 'purchases') {
    const net = Number(payload.net_amount ?? 0);
    if (net < 0) return { valid: false, error: 'purchase net_amount cannot be negative' };
  }

  if (table === 'purchase_items') {
    const qty = Number(payload.quantity ?? 0);
    if (qty <= 0) return { valid: false, error: 'purchase item quantity must be positive' };
  }

  return { valid: true };
}
