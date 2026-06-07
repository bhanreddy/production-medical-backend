import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';
import { queryRaw } from '../lib/postgresDb';

export const billsRouter = Router();

// GET /api/bills/recent
billsRouter.get('/recent', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clinicId = req.user?.clinic_id;
    if (!clinicId) {
      return res.status(400).json({ error: 'No clinic associated with this account.' });
    }

    const sales = await queryRaw(
      `SELECT s.id, s.invoice_number, s.net_amount, s.created_at, c.name as customer_name
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       WHERE s.clinic_id = ? AND s.deleted_at IS NULL AND s.is_return = false
       ORDER BY s.created_at DESC
       LIMIT 10`,
      [clinicId]
    );

    const formatted = sales.map((s: any) => ({
      id: s.id,
      invoice_number: s.invoice_number,
      net_amount: Number(s.net_amount),
      created_at: s.created_at,
      customers: {
        name: s.customer_name || 'Walk-in'
      }
    }));

    res.json({ data: formatted });
  } catch (err) {
    next(err);
  }
});


/**
 * FIFO Batch Deduction function
 * Deducts stock from the oldest expiring batches first for a given medicine.
 */
async function applyFifoDeduction(clinicId: string, medicineId: string, quantityToDeduct: number) {
  let remainingToDeduct = quantityToDeduct;

  // Fetch batches for this medicine, ordered by expiry date (FIFO)
  const { data: batches, error } = await supabaseAdmin
    .from('medicine_batches')
    .select('id, quantity_remaining')
    .eq('clinic_id', clinicId)
    .eq('medicine_id', medicineId)
    .gt('quantity_remaining', 0)
    .order('expiry_date', { ascending: true });

  if (error || !batches) {
    console.error(`Failed to fetch batches for FIFO deduction:`, error);
    return;
  }

  for (const batch of batches) {
    if (remainingToDeduct <= 0) break;

    const deductAmount = Math.min(batch.quantity_remaining, remainingToDeduct);
    const newQuantity = batch.quantity_remaining - deductAmount;

    // Update batch in DB
    await supabaseAdmin
      .from('medicine_batches')
      .update({ quantity_remaining: newQuantity, updated_at: new Date().toISOString() })
      .eq('id', batch.id)
      .eq('clinic_id', clinicId);

    remainingToDeduct -= deductAmount;
  }
  
  if (remainingToDeduct > 0) {
    console.warn(`Insufficient stock for medicine ${medicineId}. Leftover to deduct: ${remainingToDeduct}`);
  }
}

// POST /api/bills/sync
billsRouter.post('/sync', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body;
    const clinicId = req.user?.clinic_id;

    if (!clinicId) {
      return res.status(400).json({ success: false, error: 'No clinic associated with this account.' });
    }

    // Enforce server-side clinic_id
    payload.clinic_id = clinicId;
    
    // Ensure we have a client_id for idempotency
    const clientId = payload.id || payload.client_id;
    if (!clientId) {
      return res.status(400).json({ success: false, error: 'client_id or id is required for idempotency' });
    }
    payload.client_id = clientId;
    delete payload.id; // Let server generate its own ID or we map client_id to id

    // Extract items
    const items = payload.items;
    delete payload.items;

    // Upsert into sales table: ON CONFLICT (client_id) DO NOTHING
    const { data: existingSale, error: fetchError } = await supabaseAdmin
      .from('sales')
      .select('id')
      .eq('client_id', clientId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    if (existingSale) {
      // Idempotency: Duplicate submission, return success but don't re-deduct
      return res.json({ success: true, bill_id: existingSale.id });
    }

    // Map incoming payload to Postgres sales schema
    const mappedSale = {
      client_id: clientId,
      clinic_id: clinicId,
      customer_id: payload.customer_id,
      invoice_number: payload.invoice_number,
      sale_date: payload.created_at || new Date().toISOString(),
      subtotal: payload.total_amount || payload.subtotal || 0,
      discount: payload.discount_amount || payload.discount || 0,
      gst_amount: payload.tax_amount || payload.gst_amount || 0,
      net_amount: payload.final_amount || payload.net_amount || 0,
      payment_mode: payload.payment_mode ? String(payload.payment_mode).toLowerCase() : 'cash',
      payment_status: payload.payment_status ? String(payload.payment_status).toLowerCase() : 'paid',
      paid_amount: payload.final_amount || payload.paid_amount || 0,
      balance_due: 0,
      served_by: payload.user_id || payload.served_by,
    };

    // Insert new sale
    const { data: newSale, error: insertError } = await supabaseAdmin
      .from('sales')
      .insert(mappedSale)
      .select('id')
      .single();

    if (insertError) {
      return res.status(500).json({ success: false, error: insertError.message });
    }

    // Insert sale_items and deduct stock
    if (items && Array.isArray(items) && items.length > 0) {
      const itemsToInsert = items.map((item: any) => {
        let discount_pct = item.discount_pct || 0;
        if (!discount_pct && item.discount_amount && item.unit_price && item.quantity) {
           discount_pct = (item.discount_amount / (item.unit_price * item.quantity)) * 100;
        }

        return {
          sale_id: newSale.id, // Link to the newly generated sale ID
          clinic_id: clinicId,
          medicine_id: item.medicine_id || item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          mrp: item.mrp || item.unit_price || 0,
          discount_pct: discount_pct,
          gst_rate: item.gst_rate || 0,
          total: item.total_amount || item.total || 0,
        };
      });

      const { error: itemsError } = await supabaseAdmin
        .from('sale_items')
        .insert(itemsToInsert);

      if (itemsError) {
        console.error('Failed to insert sale_items:', itemsError);
      }

      for (const item of items) {
        const medicineId = item.medicine_id || item.product_id;
        if (medicineId && item.quantity) {
          await applyFifoDeduction(clinicId, medicineId, item.quantity);
        }
      }
    }

    res.json({ success: true, bill_id: newSale.id });
  } catch (err) {
    console.error('[Bills Sync]', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/bills/migrate
billsRouter.post('/migrate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bills } = req.body;
    const clinicId = req.user?.clinic_id;

    if (!clinicId) {
      return res.status(400).json({ success: false, error: 'No clinic associated with this account.' });
    }

    if (!bills || !Array.isArray(bills)) {
      return res.status(400).json({ success: false, error: 'bills array is required' });
    }

    const results = [];

    for (const bill of bills) {
      const clientId = bill.id || bill.client_id;
      if (!clientId) continue;

      // Check if already exists
      const { data: existingSale } = await supabaseAdmin
        .from('sales')
        .select('id')
        .eq('client_id', clientId)
        .limit(1)
        .maybeSingle();

      if (existingSale) {
        results.push({ id: clientId, status: 'already_migrated', server_id: existingSale.id });
        continue;
      }

      const items = bill.items || [];
      const mappedSale = {
        client_id: clientId,
        clinic_id: clinicId,
        customer_id: bill.customer_id,
        invoice_number: bill.invoice_number,
        sale_date: bill.created_at || new Date().toISOString(),
        subtotal: bill.total_amount || bill.subtotal || 0,
        discount: bill.discount_amount || bill.discount || 0,
        gst_amount: bill.tax_amount || bill.gst_amount || 0,
        net_amount: bill.final_amount || bill.net_amount || 0,
        payment_mode: bill.payment_mode ? String(bill.payment_mode).toLowerCase() : 'cash',
        payment_status: bill.payment_status ? String(bill.payment_status).toLowerCase() : 'paid',
        paid_amount: bill.final_amount || bill.paid_amount || 0,
        balance_due: 0,
        served_by: bill.user_id || bill.served_by || req.user?.id,
      };

      const { data: newSale, error: insertError } = await supabaseAdmin
        .from('sales')
        .insert(mappedSale)
        .select('id')
        .single();

      if (insertError) {
        console.error(`Migration insert sale failed for ${clientId}:`, insertError.message);
        results.push({ id: clientId, status: 'failed', error: insertError.message });
        continue;
      }

      if (items.length > 0) {
        const itemsToInsert = items.map((item: any) => {
          let discount_pct = item.discount_pct || 0;
          if (!discount_pct && item.discount_amount && item.unit_price && item.quantity) {
             discount_pct = (item.discount_amount / (item.unit_price * item.quantity)) * 100;
          }

          return {
            sale_id: newSale.id,
            clinic_id: clinicId,
            medicine_id: item.medicine_id || item.product_id,
            batch_id: item.batch_id,
            quantity: item.quantity,
            mrp: item.mrp || item.unit_price || 0,
            discount_pct: discount_pct,
            gst_rate: item.gst_rate || 0,
            total: item.total_amount || item.total || 0,
          };
        });

        const { error: itemsError } = await supabaseAdmin
          .from('sale_items')
          .insert(itemsToInsert);

        if (itemsError) {
          console.error(`Migration insert items failed for sale ${newSale.id}:`, itemsError.message);
        }

        for (const item of items) {
          const medicineId = item.medicine_id || item.product_id;
          if (medicineId && item.quantity) {
            await applyFifoDeduction(clinicId, medicineId, item.quantity);
          }
        }
      }

      results.push({ id: clientId, status: 'migrated', server_id: newSale.id });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[Bills Migration]', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default billsRouter;
