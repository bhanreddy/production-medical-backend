import { supabaseAdmin } from '../../config/supabase';
import { generateInvoiceNumber } from '../../services/invoiceNumber';
import { deductStock } from '../../services/stockLedger';
import { createSaleSchema } from '../../schemas/sale.schema';
import { publishSyncEvent } from '../redisOptional';

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function parseSince(since: string): string {
  if (!since || since === 'never') return new Date(0).toISOString();
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
  return d.toISOString();
}

export async function startSyncSession(
  clinicId: string,
  deviceId: string,
  lastSyncAt: string | undefined,
  clientVersion: string
) {
  const serverTime = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('sync_sessions')
    .insert({
      clinic_id: clinicId,
      device_id: deviceId,
      direction: 'BOTH',
      status: 'IN_PROGRESS',
      client_last_sync_at: lastSyncAt && lastSyncAt !== 'never' ? lastSyncAt : null,
      server_sync_cursor: serverTime,
    })
    .select('id')
    .single();
  if (error) throw error;

  const { data: cursorRow } = await supabaseAdmin
    .from('device_sync_cursors')
    .select('cursor_ts')
    .eq('clinic_id', clinicId)
    .eq('device_id', deviceId)
    .maybeSingle();

  await publishSyncEvent(clinicId, 'session_start', { deviceId, clientVersion });

  return {
    sessionId: data.id,
    serverTime,
    syncCursor: cursorRow?.cursor_ts || serverTime,
  };
}

export async function completeSyncSession(
  sessionId: string,
  clinicId: string,
  body: { recordsPushed: number; recordsPulled: number; conflicts?: number }
) {
  const nextSyncAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin
    .from('sync_sessions')
    .update({
      completed_at: new Date().toISOString(),
      status: 'COMPLETED',
      records_pushed: body.recordsPushed,
      records_pulled: body.recordsPulled,
      conflicts_detected: body.conflicts ?? 0,
    })
    .eq('id', sessionId)
    .eq('clinic_id', clinicId);
  if (error) throw error;
  return { ok: true as const, nextSyncAt };
}

export async function getSyncStatus(clinicId: string, deviceId: string) {
  const { data: cur } = await supabaseAdmin
    .from('device_sync_cursors')
    .select('cursor_ts')
    .eq('clinic_id', clinicId)
    .eq('device_id', deviceId)
    .maybeSingle();
  const since = cur?.cursor_ts || new Date(0).toISOString();

  const tables = ['medicines', 'customers', 'suppliers', 'sales', 'purchases', 'expenses'] as const;
  let pending = 0;
  for (const t of tables) {
    const { count } = await supabaseAdmin
      .from(t === 'sales' ? 'sales' : t)
      .select('id', { count: 'exact', head: true })
      .eq('clinic_id', clinicId)
      .gt('updated_at', since);
    pending += count || 0;
  }

  return {
    serverTime: new Date().toISOString(),
    lastSyncAt: since,
    pendingChanges: pending,
    serverVersion: 1,
  };
}

type PushRecord = {
  table: string;
  localId: string;
  remoteId: string | null;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  version: number;
  payload: Record<string, unknown>;
};

export async function applyPushRecord(
  clinicId: string,
  deviceId: string,
  rec: PushRecord
): Promise<{
  localId: string;
  remoteId: string | null;
  status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
  version: number;
  serverUpdatedAt: string;
  conflictData?: unknown;
  error?: string;
}> {
  const now = new Date().toISOString();
  const table = rec.table === 'invoices' ? 'sales' : rec.table;

  try {
    if (rec.table === 'customers') {
      return await pushCustomer(clinicId, deviceId, rec, now);
    }
    if (rec.table === 'suppliers') {
      return await pushSupplier(clinicId, deviceId, rec, now);
    }
    if (rec.table === 'medicines') {
      return await pushMedicine(clinicId, deviceId, rec, now);
    }
    if (rec.table === 'expenses') {
      return await pushExpense(clinicId, deviceId, rec, now);
    }
    if (rec.table === 'invoices') {
      return await pushInvoiceAsSale(clinicId, deviceId, rec, now);
    }
    return {
      localId: rec.localId,
      remoteId: rec.remoteId,
      status: 'REJECTED',
      version: rec.version,
      serverUpdatedAt: now,
      error: `Unsupported table: ${rec.table}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      localId: rec.localId,
      remoteId: rec.remoteId,
      status: 'REJECTED',
      version: rec.version,
      serverUpdatedAt: now,
      error: msg,
    };
  }
}

async function pushCustomer(
  clinicId: string,
  deviceId: string,
  rec: PushRecord,
  now: string
) {
  if (rec.operation === 'DELETE') {
    if (!rec.remoteId || !isUuid(rec.remoteId)) {
      return { localId: rec.localId, remoteId: null, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'DELETE requires remoteId' };
    }
    const { data: row } = await supabaseAdmin.from('customers').select('id,sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
    if (!row) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
    if (row.sync_version !== rec.version) {
      return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: row.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: row.sync_version } };
    }
    const { data: upd, error } = await supabaseAdmin
      .from('customers')
      .update({ deleted_at: now, updated_at: now, last_writer_device_id: deviceId })
      .eq('id', rec.remoteId)
      .eq('clinic_id', clinicId)
      .select('id,sync_version,updated_at')
      .single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: upd.id, status: 'ACCEPTED' as const, version: upd.sync_version, serverUpdatedAt: upd.updated_at };
  }

  const base = {
    clinic_id: clinicId,
    name: String(rec.payload.name ?? ''),
    phone: rec.payload.phone != null ? String(rec.payload.phone) : null,
    email: rec.payload.email != null ? String(rec.payload.email) : null,
    address: rec.payload.address != null ? String(rec.payload.address) : null,
    outstanding_balance: Number(rec.payload.outstandingBalance ?? rec.payload.outstanding_balance ?? 0),
    total_purchases: Number(rec.payload.totalPurchases ?? rec.payload.total_purchases ?? 0),
    updated_at: now,
    last_writer_device_id: deviceId,
  };

  if (rec.operation === 'CREATE' || !rec.remoteId) {
    const { data, error } = await supabaseAdmin.from('customers').insert({ ...base }).select('id,sync_version,updated_at').single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
  }

  const { data: existing } = await supabaseAdmin.from('customers').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
  if (!existing) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
  if (existing.sync_version !== rec.version) {
    return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: existing.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: existing.sync_version } };
  }
  const { data, error } = await supabaseAdmin
    .from('customers')
    .update({ ...base })
    .eq('id', rec.remoteId)
    .eq('clinic_id', clinicId)
    .select('id,sync_version,updated_at')
    .single();
  if (error) throw error;
  return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
}

async function pushSupplier(clinicId: string, deviceId: string, rec: PushRecord, now: string) {
  if (rec.operation === 'DELETE') {
    if (!rec.remoteId || !isUuid(rec.remoteId)) {
      return { localId: rec.localId, remoteId: null, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'DELETE requires remoteId' };
    }
    const { data: row } = await supabaseAdmin.from('suppliers').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
    if (!row) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
    if (row.sync_version !== rec.version) {
      return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: row.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: row.sync_version } };
    }
    const { data: upd, error } = await supabaseAdmin
      .from('suppliers')
      .update({ deleted_at: now, updated_at: now, last_writer_device_id: deviceId })
      .eq('id', rec.remoteId)
      .eq('clinic_id', clinicId)
      .select('id,sync_version,updated_at')
      .single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: upd.id, status: 'ACCEPTED' as const, version: upd.sync_version, serverUpdatedAt: upd.updated_at };
  }

  const base = {
    clinic_id: clinicId,
    name: String(rec.payload.name ?? ''),
    phone: rec.payload.phone != null ? String(rec.payload.phone) : null,
    email: rec.payload.email != null ? String(rec.payload.email) : null,
    address: rec.payload.address != null ? String(rec.payload.address) : null,
    gstin: rec.payload.gstin != null ? String(rec.payload.gstin) : null,
    updated_at: now,
    last_writer_device_id: deviceId,
  };

  if (rec.operation === 'CREATE' || !rec.remoteId) {
    const { data, error } = await supabaseAdmin.from('suppliers').insert({ ...base }).select('id,sync_version,updated_at').single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
  }

  const { data: existing } = await supabaseAdmin.from('suppliers').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
  if (!existing) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
  if (existing.sync_version !== rec.version) {
    return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: existing.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: existing.sync_version } };
  }
  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .update({ ...base })
    .eq('id', rec.remoteId)
    .eq('clinic_id', clinicId)
    .select('id,sync_version,updated_at')
    .single();
  if (error) throw error;
  return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
}

async function pushMedicine(clinicId: string, deviceId: string, rec: PushRecord, now: string) {
  const gstRaw = rec.payload.gst ?? rec.payload.gst_rate ?? 0;
  const gstNum = Number(gstRaw);
  const gst_rate = [0, 5, 12, 18].includes(gstNum) ? gstNum : 0;

  if (rec.operation === 'DELETE') {
    if (!rec.remoteId || !isUuid(rec.remoteId)) {
      return { localId: rec.localId, remoteId: null, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'DELETE requires remoteId' };
    }
    const { data: row } = await supabaseAdmin.from('medicines').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
    if (!row) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
    if (row.sync_version !== rec.version) {
      return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: row.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: row.sync_version } };
    }
    const { data: upd, error } = await supabaseAdmin
      .from('medicines')
      .update({ deleted_at: now, updated_at: now, last_writer_device_id: deviceId, is_active: false })
      .eq('id', rec.remoteId)
      .eq('clinic_id', clinicId)
      .select('id,sync_version,updated_at')
      .single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: upd.id, status: 'ACCEPTED' as const, version: upd.sync_version, serverUpdatedAt: upd.updated_at };
  }

  const base = {
    clinic_id: clinicId,
    name: String(rec.payload.name ?? ''),
    generic_name:
      rec.payload.genericName != null
        ? String(rec.payload.genericName)
        : rec.payload.generic_name != null
          ? String(rec.payload.generic_name)
          : null,
    manufacturer: rec.payload.manufacturer != null ? String(rec.payload.manufacturer) : null,
    category: rec.payload.category != null ? String(rec.payload.category) : 'tablet',
    hsn_code: rec.payload.hsn != null ? String(rec.payload.hsn) : rec.payload.hsn_code != null ? String(rec.payload.hsn_code) : null,
    gst_rate,
    unit: rec.payload.unit != null ? String(rec.payload.unit) : 'strip',
    low_stock_threshold: Number(rec.payload.minStock ?? rec.payload.low_stock_threshold ?? 10),
    updated_at: now,
    last_writer_device_id: deviceId,
  };

  if (rec.operation === 'CREATE' || !rec.remoteId) {
    const { data, error } = await supabaseAdmin.from('medicines').insert({ ...base }).select('id,sync_version,updated_at').single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
  }

  const { data: existing } = await supabaseAdmin.from('medicines').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
  if (!existing) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
  if (existing.sync_version !== rec.version) {
    return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: existing.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: existing.sync_version } };
  }
  const { data, error } = await supabaseAdmin
    .from('medicines')
    .update({ ...base })
    .eq('id', rec.remoteId)
    .eq('clinic_id', clinicId)
    .select('id,sync_version,updated_at')
    .single();
  if (error) throw error;
  return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
}

const EXPENSE_CATS = ['rent', 'salary', 'utilities', 'supplies', 'maintenance', 'misc'] as const;

async function pushExpense(clinicId: string, deviceId: string, rec: PushRecord, now: string) {
  const catRaw = String(rec.payload.category ?? 'misc').toLowerCase();
  const category = EXPENSE_CATS.includes(catRaw as (typeof EXPENSE_CATS)[number]) ? catRaw : 'misc';

  if (rec.operation === 'DELETE') {
    if (!rec.remoteId || !isUuid(rec.remoteId)) {
      return { localId: rec.localId, remoteId: null, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'DELETE requires remoteId' };
    }
    const { data: row } = await supabaseAdmin.from('expenses').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
    if (!row) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
    if (row.sync_version !== rec.version) {
      return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: row.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: row.sync_version } };
    }
    const { data: upd, error } = await supabaseAdmin
      .from('expenses')
      .update({ deleted_at: now, updated_at: now, last_writer_device_id: deviceId })
      .eq('id', rec.remoteId)
      .eq('clinic_id', clinicId)
      .select('id,sync_version,updated_at')
      .single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: upd.id, status: 'ACCEPTED' as const, version: upd.sync_version, serverUpdatedAt: upd.updated_at };
  }

  const base = {
    clinic_id: clinicId,
    category,
    description: rec.payload.description != null ? String(rec.payload.description) : null,
    amount: Number(rec.payload.amount ?? 0),
    expense_date: String(rec.payload.expenseDate ?? rec.payload.expense_date ?? now).slice(0, 10),
    payment_mode: String(rec.payload.payment_mode ?? rec.payload.paymentMode ?? 'cash').toLowerCase(),
    recorded_by: rec.payload.recorded_by != null ? String(rec.payload.recorded_by) : null,
    updated_at: now,
    last_writer_device_id: deviceId,
  };

  if (rec.operation === 'CREATE' || !rec.remoteId) {
    const { data, error } = await supabaseAdmin.from('expenses').insert({ ...base }).select('id,sync_version,updated_at').single();
    if (error) throw error;
    return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
  }

  const { data: existing } = await supabaseAdmin.from('expenses').select('sync_version').eq('id', rec.remoteId).eq('clinic_id', clinicId).single();
  if (!existing) return { localId: rec.localId, remoteId: rec.remoteId, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Not found' };
  if (existing.sync_version !== rec.version) {
    return { localId: rec.localId, remoteId: rec.remoteId, status: 'CONFLICT' as const, version: existing.sync_version, serverUpdatedAt: now, conflictData: { expectedVersion: existing.sync_version } };
  }
  const { data, error } = await supabaseAdmin
    .from('expenses')
    .update({ ...base })
    .eq('id', rec.remoteId)
    .eq('clinic_id', clinicId)
    .select('id,sync_version,updated_at')
    .single();
  if (error) throw error;
  return { localId: rec.localId, remoteId: data.id, status: 'ACCEPTED' as const, version: data.sync_version, serverUpdatedAt: data.updated_at };
}

async function resolveBatchId(
  clinicId: string,
  medicineId: string,
  batchNumber: string
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('medicine_batches')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('medicine_id', medicineId)
    .eq('batch_number', batchNumber)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function pushInvoiceAsSale(clinicId: string, deviceId: string, rec: PushRecord, now: string) {
  if (rec.operation !== 'CREATE') {
    return {
      localId: rec.localId,
      remoteId: rec.remoteId,
      status: 'REJECTED' as const,
      version: rec.version,
      serverUpdatedAt: now,
      error: 'Only CREATE supported for invoices in v1',
    };
  }

  const items = (rec.payload.items as Record<string, unknown>[]) || [];
  const resolved: { medicine_id: string; batch_id: string; quantity: number; mrp: number; discount_pct: number; gst_rate: number }[] = [];
  for (const it of items) {
    const medId = String(it.medicineRemoteId ?? it.medicine_id ?? it.medicineId ?? '');
    const medicineId = isUuid(medId) ? medId : '';
    if (!medicineId) {
      return { localId: rec.localId, remoteId: null, status: 'REJECTED' as const, version: rec.version, serverUpdatedAt: now, error: 'Each item needs medicine UUID (medicineRemoteId)' };
    }
    const batchNumber = String(it.batch ?? it.batchNumber ?? '');
    const batchId = await resolveBatchId(clinicId, medicineId, batchNumber);
    if (!batchId) {
      return {
        localId: rec.localId,
        remoteId: null,
        status: 'REJECTED' as const,
        version: rec.version,
        serverUpdatedAt: now,
        error: `No batch for medicine ${medicineId} batch ${batchNumber}`,
      };
    }
    resolved.push({
      medicine_id: medicineId,
      batch_id: batchId,
      quantity: Number(it.qty ?? it.quantity ?? 0),
      mrp: Number(it.unitPrice ?? it.mrp ?? 0),
      discount_pct: Number(it.discount ?? it.discount_pct ?? 0),
      gst_rate: Number(it.gst ?? it.gst_rate ?? 0),
    });
  }

  const body = {
    customer_id: rec.payload.customerId ?? rec.payload.customer_id ?? null,
    discount: Number(rec.payload.discount ?? 0),
    payment_mode: String(rec.payload.paymentMode ?? rec.payload.payment_mode ?? 'cash').toLowerCase(),
    payment_status: String(rec.payload.paymentStatus ?? rec.payload.payment_status ?? 'paid').toLowerCase(),
    paid_amount: Number(rec.payload.total ?? rec.payload.paid_amount ?? 0),
    items: resolved,
  };

  const parsed = createSaleSchema.safeParse(body);
  if (!parsed.success) {
    return {
      localId: rec.localId,
      remoteId: null,
      status: 'REJECTED' as const,
      version: rec.version,
      serverUpdatedAt: now,
      error: parsed.error.message,
    };
  }

  const invoiceNumber =
    (rec.payload.invoiceNumber as string) || (await generateInvoiceNumber(clinicId));

  await deductStock(parsed.data.items, clinicId, supabaseAdmin);

  const net = Number(rec.payload.total ?? 0);
  const subtotal = Number(rec.payload.subtotal ?? net);
  const gst_amount = Number(rec.payload.tax ?? rec.payload.gst_amount ?? 0);

  const { data: sale, error: saleErr } = await supabaseAdmin
    .from('sales')
    .insert({
      clinic_id: clinicId,
      customer_id: parsed.data.customer_id,
      invoice_number: invoiceNumber,
      sale_date: now,
      subtotal,
      discount: parsed.data.discount,
      gst_amount,
      net_amount: net,
      payment_mode: parsed.data.payment_mode,
      payment_status: parsed.data.payment_status,
      paid_amount: parsed.data.paid_amount,
      balance_due: Math.max(0, net - parsed.data.paid_amount),
      updated_at: now,
    })
    .select('id,sync_version,updated_at')
    .single();
  if (saleErr) throw saleErr;

  const saleItems = parsed.data.items.map((it) => ({
    clinic_id: clinicId,
    sale_id: sale.id,
    medicine_id: it.medicine_id,
    batch_id: it.batch_id,
    quantity: it.quantity,
    mrp: it.mrp,
    discount_pct: it.discount_pct,
    gst_rate: it.gst_rate,
    total: it.quantity * it.mrp * (1 - it.discount_pct / 100),
  }));

  const { error: siErr } = await supabaseAdmin.from('sale_items').insert(saleItems);
  if (siErr) throw siErr;

  await supabaseAdmin.from('stock_ledger').insert({
    clinic_id: clinicId,
    medicine_id: resolved[0]?.medicine_id,
    movement_type: 'SALE',
    reference_id: sale.id,
    reference_type: 'INVOICE',
    qty_change: -resolved.reduce((s, x) => s + x.quantity, 0),
    note: `Invoice ${invoiceNumber}`,
    device_id: deviceId,
  });

  return {
    localId: rec.localId,
    remoteId: sale.id,
    status: 'ACCEPTED' as const,
    version: sale.sync_version,
    serverUpdatedAt: sale.updated_at,
  };
}

function mapMedicineRow(r: Record<string, unknown>) {
  return {
    ...r,
    genericName: r.generic_name,
    hsn: r.hsn_code,
    gst: r.gst_rate,
    minStock: r.low_stock_threshold,
    remoteId: r.id,
    version: r.sync_version,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapCustomerRow(r: Record<string, unknown>) {
  return {
    ...r,
    totalPurchases: r.total_purchases,
    outstandingBalance: r.outstanding_balance,
    remoteId: r.id,
    version: r.sync_version,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapSupplierRow(r: Record<string, unknown>) {
  return {
    ...r,
    contactPerson: null,
    remoteId: r.id,
    version: r.sync_version,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapExpenseRow(r: Record<string, unknown>) {
  return {
    ...r,
    expenseDate: r.expense_date,
    remoteId: r.id,
    version: r.sync_version,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapSaleAsInvoice(r: Record<string, unknown>) {
  return {
    ...r,
    table: 'invoices',
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    billedAt: r.sale_date,
    remoteId: r.id,
    version: r.sync_version,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export async function pullChanges(
  clinicId: string,
  deviceId: string,
  sinceParam: string,
  tablesCsv: string,
  limit: number
) {
  const since = parseSince(sinceParam);
  const tables = tablesCsv.split(',').map((t) => t.trim()).filter(Boolean);
  const lim = Math.min(Math.max(limit || 500, 1), 500);
  const changes: {
    table: string;
    remoteId: string;
    operation: 'UPSERT' | 'DELETE';
    version: number;
    updatedAt: string;
    deletedAt: string | null;
    data: Record<string, unknown>;
  }[] = [];

  const pushRows = (table: string, rows: Record<string, unknown>[], mapper: (r: Record<string, unknown>) => Record<string, unknown>) => {
    for (const r of rows) {
      const deletedAt = (r.deleted_at as string) || null;
      changes.push({
        table,
        remoteId: r.id as string,
        operation: deletedAt ? 'DELETE' : 'UPSERT',
        version: Number(r.sync_version ?? 1),
        updatedAt: (r.updated_at as string) || (r.created_at as string),
        deletedAt,
        data: mapper(r),
      });
    }
  };

  for (const t of tables) {
    if (changes.length >= lim) break;
    const remaining = lim - changes.length;
    if (t === 'medicines') {
      const { data } = await supabaseAdmin
        .from('medicines')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('medicines', data || [], mapMedicineRow);
    } else if (t === 'customers') {
      const { data } = await supabaseAdmin
        .from('customers')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('customers', data || [], mapCustomerRow);
    } else if (t === 'suppliers') {
      const { data } = await supabaseAdmin
        .from('suppliers')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('suppliers', data || [], mapSupplierRow);
    } else if (t === 'expenses') {
      const { data } = await supabaseAdmin
        .from('expenses')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('expenses', data || [], mapExpenseRow);
    } else if (t === 'invoices') {
      const { data } = await supabaseAdmin
        .from('sales')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('invoices', data || [], mapSaleAsInvoice);
    } else if (t === 'purchases') {
      const { data } = await supabaseAdmin
        .from('purchases')
        .select('*')
        .eq('clinic_id', clinicId)
        .gt('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(remaining);
      pushRows('purchases', data || [], (r) => ({ ...r, remoteId: r.id, version: r.sync_version, updatedAt: r.updated_at, deletedAt: r.deleted_at }));
    }
  }

  const cursor =
    changes.length > 0 ? changes[changes.length - 1]!.updatedAt : sinceParam === 'never' ? new Date().toISOString() : since;
  const hasMore = changes.length >= lim;

  await supabaseAdmin.from('device_sync_cursors').upsert(
    {
      clinic_id: clinicId,
      device_id: deviceId,
      cursor_ts: cursor,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'clinic_id,device_id' }
  );

  return {
    cursor,
    hasMore,
    changes,
    serverTime: new Date().toISOString(),
    totalChanges: changes.length,
  };
}

export async function seedFullPage(clinicId: string, page: number, limit: number) {
  const lim = Math.min(Math.max(limit, 1), 1000);
  const offset = (Math.max(page, 1) - 1) * lim;
  const serverTime = new Date().toISOString();

  const [med, cust, sup, sal, pur, exp] = await Promise.all([
    supabaseAdmin.from('medicines').select('*').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
    supabaseAdmin.from('customers').select('*').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
    supabaseAdmin.from('suppliers').select('*').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
    supabaseAdmin.from('sales').select('*, sale_items(*)').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
    supabaseAdmin.from('purchases').select('*').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
    supabaseAdmin.from('expenses').select('*').eq('clinic_id', clinicId).range(offset, offset + lim - 1),
  ]);

  return {
    page,
    limit: lim,
    serverTime,
    medicines: med.data || [],
    customers: cust.data || [],
    suppliers: sup.data || [],
    invoices: sal.data || [],
    purchases: pur.data || [],
    expenses: exp.data || [],
    errors: [med.error, cust.error, sup.error, sal.error, pur.error, exp.error].filter(Boolean),
  };
}
