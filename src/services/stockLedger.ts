import { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../lib/appError';
import { planFifoDeductions, isBatchExpired } from '../lib/fifoStock';

export type DeductStockItem =
  | { medicine_id: string; batch_id: string; quantity: number }
  | { medicine_id: string; quantity: number; batch_id?: undefined };

async function applyBatchDeduction(
  supabase: SupabaseClient,
  clinicId: string,
  batchId: string,
  deductQty: number
): Promise<void> {
  const { data: batch, error: batchError } = await supabase
    .from('medicine_batches')
    .select('id, quantity_remaining')
    .eq('clinic_id', clinicId)
    .eq('id', batchId)
    .single();

  if (batchError || !batch) {
    throw new AppError(400, `Batch ${batchId} not found.`, 'BATCH_NOT_FOUND');
  }

  if (batch.quantity_remaining < deductQty) {
    throw new AppError(
      400,
      `Insufficient stock for batch ${batchId}. Available: ${batch.quantity_remaining}`,
      'INSUFFICIENT_STOCK'
    );
  }

  const newQuantity = batch.quantity_remaining - deductQty;
  const { error: updateError } = await supabase
    .from('medicine_batches')
    .update({ quantity_remaining: newQuantity })
    .eq('id', batchId)
    .eq('clinic_id', clinicId);

  if (updateError) throw updateError;
}

export async function deductStock(
  items: DeductStockItem[],
  clinicId: string,
  supabase: SupabaseClient
): Promise<void> {
  for (const item of items) {
    if (item.batch_id) {
      const { data: row, error } = await supabase
        .from('medicine_batches')
        .select('id, medicine_id, expiry_date, quantity_remaining, clinic_id')
        .eq('id', item.batch_id)
        .single();

      if (error || !row) {
        throw new AppError(400, `Batch ${item.batch_id} not found.`, 'BATCH_NOT_FOUND');
      }

      if (row.clinic_id !== clinicId) {
        throw new AppError(400, 'Batch not found for this clinic.', 'BATCH_NOT_FOUND');
      }

      if (row.medicine_id !== item.medicine_id) {
        throw new AppError(400, 'Batch does not belong to the specified medicine.', 'BATCH_MEDICINE_MISMATCH');
      }

      if (isBatchExpired(row.expiry_date)) {
        throw new AppError(400, 'Cannot sell from an expired batch.', 'EXPIRED_BATCH');
      }

      await applyBatchDeduction(supabase, clinicId, item.batch_id, item.quantity);
    } else {
      const { data: rows, error: listErr } = await supabase
        .from('medicine_batches')
        .select('id, medicine_id, expiry_date, quantity_remaining')
        .eq('clinic_id', clinicId)
        .eq('medicine_id', item.medicine_id);

      if (listErr) throw listErr;

      const plans = planFifoDeductions(rows || [], item.quantity);
      for (const p of plans) {
        await applyBatchDeduction(supabase, clinicId, p.batch_id, p.quantity);
      }
    }
  }
}

export async function restockBatch(
  item: {
    medicine_id: string;
    supplier_id?: string | null;
    purchase_id: string;
    batch_number: string;
    expiry_date: string;
    quantity: number;
    purchase_price: number;
    mrp: number;
  },
  clinicId: string,
  supabase: SupabaseClient
): Promise<string> {
  const { data: existingBatch } = await supabase
    .from('medicine_batches')
    .select('id, quantity_in, quantity_remaining')
    .eq('clinic_id', clinicId)
    .eq('medicine_id', item.medicine_id)
    .eq('batch_number', item.batch_number)
    .single();

  if (existingBatch) {
    const { error } = await supabase
      .from('medicine_batches')
      .update({
        quantity_in: existingBatch.quantity_in + item.quantity,
        quantity_remaining: existingBatch.quantity_remaining + item.quantity,
        mrp: item.mrp,
        purchase_price: item.purchase_price,
        expiry_date: item.expiry_date,
        supplier_id: item.supplier_id || null,
        purchase_id: item.purchase_id,
      })
      .eq('id', existingBatch.id);

    if (error) throw error;
    return existingBatch.id;
  }

  const { data: newBatch, error: insertError } = await supabase
    .from('medicine_batches')
    .insert({
      clinic_id: clinicId,
      medicine_id: item.medicine_id,
      supplier_id: item.supplier_id || null,
      purchase_id: item.purchase_id,
      batch_number: item.batch_number,
      expiry_date: item.expiry_date,
      mrp: item.mrp,
      purchase_price: item.purchase_price,
      quantity_in: item.quantity,
      quantity_remaining: item.quantity,
    })
    .select('id')
    .single();

  if (insertError) throw insertError;
  return newBatch.id;
}

export async function restoreStock(
  items: Array<{ batch_id: string; quantity: number }>,
  clinicId: string,
  supabase: SupabaseClient
): Promise<void> {
  for (const item of items) {
    const { data: batch, error: batchError } = await supabase
      .from('medicine_batches')
      .select('id, quantity_remaining')
      .eq('clinic_id', clinicId)
      .eq('id', item.batch_id)
      .single();

    if (batchError || !batch) continue;

    const { error } = await supabase
      .from('medicine_batches')
      .update({ quantity_remaining: batch.quantity_remaining + item.quantity })
      .eq('id', item.batch_id);

    if (error) throw error;
  }
}

export async function checkAndAutoShortbook(
  medicineId: string,
  clinicId: string,
  supabase: SupabaseClient
): Promise<void> {
  const { data: stockView } = await supabase
    .from('medicine_stock')
    .select('total_stock')
    .eq('clinic_id', clinicId)
    .eq('medicine_id', medicineId)
    .single();

  const total_stock = stockView ? Number(stockView.total_stock) : 0;

  const { data: medicine } = await supabase
    .from('medicines')
    .select('low_stock_threshold')
    .eq('id', medicineId)
    .eq('clinic_id', clinicId)
    .single();

  if (medicine && total_stock <= Number(medicine.low_stock_threshold)) {
    const { data: existingShortbook } = await supabase
      .from('shortbook')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('medicine_id', medicineId)
      .eq('is_ordered', false)
      .maybeSingle();

    if (!existingShortbook) {
      await supabase.from('shortbook').insert({
        clinic_id: clinicId,
        medicine_id: medicineId,
        reason: 'low_stock',
        quantity_needed: Math.max(Number(medicine.low_stock_threshold) * 2, 10),
      });
    }
  }
}
