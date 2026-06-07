import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { supabaseAdmin } from '../config/supabase';
import { createPurchaseSchema, updatePaymentSchema, csvRowSchema } from '../schemas/purchase.schema';


import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { parse as parseCsv } from 'csv-parse/sync';

export const purchasesRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/purchases
purchasesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 500);
    const supplier_id = req.query.supplier_id as string;
    const from = req.query.from as string;
    const to = req.query.to as string;
    const status = req.query.status as string;
    const clinicId = req.user!.clinic_id!;

    const conditions: string[] = ['p.clinic_id = ?'];
    const values: any[] = [clinicId];

    if (supplier_id) { conditions.push('p.supplier_id::text = ?'); values.push(supplier_id); }
    if (status) { conditions.push('p.payment_status = ?'); values.push(status); }
    if (from) { conditions.push('p.created_at >= ?'); values.push(from); }
    if (to) { conditions.push('p.created_at <= ?'); values.push(to); }

    const where = conditions.join(' AND ');
    const totalRows = await queryRaw<{ cnt: number }>(
      `SELECT COUNT(*)::int as cnt FROM purchases p WHERE p.deleted_at IS NULL AND ${where}`,
      values
    );
    const total = Number(totalRows[0]?.cnt ?? 0);
    const offset = (page - 1) * limit;

    const data = await queryRaw(
      `SELECT p.*, sup.name as supplier_name
       FROM purchases p
       LEFT JOIN suppliers sup ON (sup.id::text = p.supplier_id::text OR sup._local_id::text = p.supplier_id::text)
       WHERE p.deleted_at IS NULL AND ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    for (const p of data as any[]) {
      p.suppliers = { name: p.supplier_name ?? '' };
    }

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/:id
purchasesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const purchase = await queryOne('purchases', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const purchaseId = (purchase as any).id;
    const purchaseItems = await queryAll('purchase_items', 'purchase_id=?', [purchaseId]);

    // Attach medicine names (in batch)
    const medicineIds = purchaseItems.map((item: any) => item.medicine_id).filter(Boolean);
    if (medicineIds.length > 0) {
      const placeholders = medicineIds.map(() => '?').join(',');
      const medicines = await queryRaw(
        `SELECT id, _local_id, name, generic_name FROM medicines WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...medicineIds, ...medicineIds]
      );
      const medicineMap = new Map();
      for (const med of medicines) {
        medicineMap.set(med.id, med);
        medicineMap.set(med._local_id, med);
      }
      for (const item of purchaseItems) {
        if (item.medicine_id) {
          const med = medicineMap.get(item.medicine_id);
          item.medicines = { name: med?.name ?? '', generic_name: med?.generic_name ?? '' };
        } else {
          item.medicines = { name: '', generic_name: '' };
        }
      }
    } else {
      for (const item of purchaseItems) {
        item.medicines = { name: '', generic_name: '' };
      }
    }

    res.json({ data: { ...purchase, purchase_items: purchaseItems } });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases
purchasesRouter.post('/', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const parsed = createPurchaseSchema.parse(req.body);
    
    // Server-side calculations
    let subtotal = 0;
    let gst_amount = 0;

    for (const item of parsed.items) {
      subtotal += item.quantity * item.purchase_price;
      gst_amount += (item.quantity * item.purchase_price * item.gst_rate) / 100;
    }

    const net_amount = subtotal - 0 + gst_amount;

    // Resolve supplier_id
    const clinicId = req.user!.clinic_id!;
    let supplierId = null;
    if (parsed.supplier_id) {
      const supp = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [parsed.supplier_id, parsed.supplier_id, clinicId]);
      if (supp) {
        supplierId = (supp as any).id;
      }
    }

    // Insert purchase locally
    const purchase = await localMutate({
      table: 'purchases',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        supplier_id: supplierId,
        invoice_number: parsed.invoice_number,
        invoice_date: parsed.invoice_date,
        bill_image_url: parsed.bill_image_url,
        notes: parsed.notes,
        subtotal,
        discount: 0,
        gst_amount,
        net_amount,
        payment_status: 'unpaid',
        paid_amount: 0,
        created_by: req.user!.id
      }
    });

    // Insert purchase items + update batch stock
    for (const item of parsed.items) {
      // Resolve medicine_id to actual DB UUID id
      const med = await queryOne('medicines', '(_local_id=? OR id=?) AND clinic_id=?', [item.medicine_id, item.medicine_id, clinicId]);
      if (!med) {
        throw new Error(`Medicine not found for ID: ${item.medicine_id}`);
      }
      const resolvedMedicineId = (med as any).id;

      await localMutate({
        table: 'purchase_items',
        operation: 'INSERT',
        data: {
          clinic_id: clinicId,
          purchase_id: purchase.id,
          medicine_id: resolvedMedicineId,
          batch_number: item.batch_number,
          expiry_date: item.expiry_date,
          quantity: item.quantity,
          purchase_price: item.purchase_price,
          mrp: item.mrp,
          gst_rate: item.gst_rate,
          discount: item.discount,
          total: item.quantity * item.purchase_price * (1 - item.discount / 100)
        }
      });

      // Increment stock on batch
      const existingBatch = await queryOne('medicine_batches', 'medicine_id=? AND batch_number=? AND clinic_id=?', [resolvedMedicineId, item.batch_number, clinicId]);
      if (existingBatch) {
        const oldQty = Number((existingBatch as any).quantity_remaining ?? 0);
        const oldPp = Number((existingBatch as any).purchase_price ?? 0);
        const addQty = item.quantity;
        const inboundPp = item.purchase_price;
        const newQty = oldQty + addQty;
        const blendedPp =
          newQty > 0 && oldQty > 0 && oldPp > 0
            ? (oldQty * oldPp + addQty * inboundPp) / newQty
            : inboundPp;

        await localMutate({
          table: 'medicine_batches',
          operation: 'UPDATE',
          data: {
            _local_id: (existingBatch as any)._local_id,
            quantity_remaining: newQty,
            purchase_price: blendedPp,
          }
        });
      } else {
        await localMutate({
          table: 'medicine_batches',
          operation: 'INSERT',
          data: {
            clinic_id: req.user!.clinic_id!,
            medicine_id: resolvedMedicineId,
            purchase_id: purchase.id,
            batch_number: item.batch_number,
            expiry_date: item.expiry_date,
            quantity_in: item.quantity,
            quantity_remaining: item.quantity,
            purchase_price: item.purchase_price,
            mrp: item.mrp,
          }
        });
      }
    }

    res.status(201).json({ data: purchase });
  } catch (err) {
    next(err);
  }
});

// PUT /api/purchases/:id
purchasesRouter.put('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('purchases', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const { invoice_number, invoice_date, notes } = req.body;
    
    const data = await localMutate({
      table: 'purchases',
      operation: 'UPDATE',
      data: { invoice_number, invoice_date, notes, _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/purchases/:id/payment
purchasesRouter.patch('/:id/payment', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('purchases', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const parsed = updatePaymentSchema.parse(req.body);

    const data = await localMutate({
      table: 'purchases',
      operation: 'UPDATE',
      data: { paid_amount: parsed.paid_amount, payment_status: parsed.payment_status, _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/bill-scan (requires network — Anthropic AI)
purchasesRouter.post('/bill-scan', requireAuth, async (req, res, next) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'imageBase64 and mimeType are required' });
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    const filename = `${new Date().getTime()}.jpg`;
    
    // Upload image
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('purchase-bills')
      .upload(`${req.user!.clinic_id!}/${filename}`, buffer, { contentType: mimeType });

    if (uploadError) throw uploadError;

    const bill_image_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/purchase-bills/${req.user!.clinic_id!}/${filename}`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 2000,
      system: 'You are a pharmacy bill parser. Extract structured data.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType as any, data: imageBase64 }
            },
            {
              type: 'text',
              text: "Extract: supplier name, invoice number, invoice date (YYYY-MM-DD), and all line items: medicine name, batch number, expiry date (YYYY-MM-DD), quantity, MRP, purchase price, GST rate. Return ONLY valid JSON, no markdown."
            }
          ]
        }
      ]
    });

    // Remove markdown fences from claude output
    let text = (response.content[0] as any).text.trim();
    if (text.startsWith('```json')) text = text.replace(/^```json/, '');
    if (text.startsWith('```')) text = text.replace(/^```/, '');
    if (text.endsWith('```')) text = text.replace(/```$/, '');
    
    const parsedData = JSON.parse(text.trim());

    res.json({ data: { bill_image_url, extracted: parsedData } });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/import-csv
purchasesRouter.post('/import-csv', requireAuth, requireRole('OWNER'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

    const records = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true });

    let success = 0;
    let failed = 0;
    const errors = [];

    for (const record of records) {
      try {
        const validated = csvRowSchema.parse(record);
        
        // Convert MM/YYYY -> YYYY-MM-DD
        const [mm, yyyy] = validated.expiry_date.split('/');
        const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
        const expiryIso = `${yyyy}-${mm.padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

        // Create medicine locally
        const med = await localMutate({
          table: 'medicines',
          operation: 'INSERT',
          data: {
            clinic_id: req.user!.clinic_id!,
            name: validated.medicine_name,
            generic_name: validated.generic_name || null,
            manufacturer: validated.manufacturer || null,
            gst_rate: validated.gst_rate,
            is_active: true,
          }
        });

        // Create batch locally
        await localMutate({
          table: 'medicine_batches',
          operation: 'INSERT',
          data: {
            clinic_id: req.user!.clinic_id!,
            medicine_id: med.id,
            batch_number: validated.batch_number,
            expiry_date: expiryIso,
            quantity_received: validated.quantity,
            quantity_remaining: validated.quantity,
            purchase_price: validated.purchase_price,
            mrp: validated.mrp,
          }
        });

        success++;
      } catch (e: any) {
        failed++;
        errors.push({ row: record, reason: e.message });
      }
    }

    res.json({ success, failed, errors });
  } catch (err) {
    next(err);
  }
});


// --- PURCHASE ORDERS ---

// GET /api/purchases/purchase-orders
purchasesRouter.get('/purchase-orders', requireAuth, async (req, res, next) => {
  try {
    const data = await queryAll('purchase_orders', 'clinic_id = ?', [req.user!.clinic_id!]);
    data.sort((a: any, b: any) => String(b.order_date ?? '').localeCompare(String(a.order_date ?? '')));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/purchase-orders
purchasesRouter.post('/purchase-orders', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { supplier_id, notes, lines } = req.body;
    const count = await queryCount('purchase_orders', 'clinic_id = ?', [req.user!.clinic_id!]);
    const poNumber = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(count + 1).padStart(4, '0')}`;
    
    const data = await localMutate({
      table: 'purchase_orders',
      operation: 'INSERT',
      data: {
        clinic_id: req.user!.clinic_id!,
        supplier_id,
        po_number: poNumber,
        status: 'DRAFT',
        order_date: new Date().toISOString().slice(0, 10),
        notes: notes || null,
        lines_json: JSON.stringify(lines || [])
      }
    });
    
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/purchases/purchase-orders/:id/status
purchasesRouter.patch('/purchase-orders/:id/status', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('purchase_orders', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const { status } = req.body;
    const data = await localMutate({
      table: 'purchase_orders',
      operation: 'UPDATE',
      data: {
        _local_id: localId,
        status
      }
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// --- PURCHASE RETURNS ---

// GET /api/purchases/purchase-returns
purchasesRouter.get('/purchase-returns', requireAuth, async (req, res, next) => {
  try {
    const data = await queryAll('purchase_returns', 'clinic_id = ?', [req.user!.clinic_id!]);
    data.sort((a: any, b: any) => String(b.return_date ?? '').localeCompare(String(a.return_date ?? '')));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/purchase-returns
purchasesRouter.post('/purchase-returns', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { supplier_id, reference_note, lines } = req.body;
    if (!lines || !lines.length) {
      return res.status(400).json({ error: 'Return requires at least one line' });
    }

    const now = new Date().toISOString();
    let totalValue = 0;
    
    // Create the purchase return row
    const returnHeader = await localMutate({
      table: 'purchase_returns',
      operation: 'INSERT',
      data: {
        clinic_id: req.user!.clinic_id!,
        supplier_id,
        return_date: now.slice(0, 10),
        reference_note: reference_note || null,
        status: 'POSTED',
        total_value: 0 // Will update later
      }
    });

    const returnId = returnHeader.id;
    const returnLocalId = returnHeader._local_id;
    const clinicId = req.user!.clinic_id!;

    for (const ln of lines) {
      const batch = await queryOne('medicine_batches', '(_local_id = ? OR id = ?) AND clinic_id = ?', [ln.batchId, ln.batchId, clinicId]);
      if (!batch) {
        throw new Error(`Batch ${ln.batchId} not found`);
      }
      
      const onHand = Number((batch as any).quantity_remaining ?? 0);
      if (onHand < ln.quantity) {
        throw new Error(`Insufficient stock to return for batch ${(batch as any).batch_number}`);
      }

      const rate = Number((batch as any).purchase_price ?? 0);
      const lineTotal = Math.round(ln.quantity * rate * 100) / 100;
      totalValue += lineTotal;

      // Update quantity remaining on batch
      await localMutate({
        table: 'medicine_batches',
        operation: 'UPDATE',
        data: {
          _local_id: (batch as any)._local_id,
          quantity_remaining: onHand - ln.quantity
        }
      });

      // Insert line
      await localMutate({
        table: 'purchase_return_lines',
        operation: 'INSERT',
        data: {
          clinic_id: clinicId,
          return_id: returnId,
          batch_id: ln.batchId,
          medicine_id: (batch as any).medicine_id,
          quantity: ln.quantity,
          rate
        }
      });
    }

    // Update total value in header
    const roundedTotal = Math.round(totalValue * 100) / 100;
    await localMutate({
      table: 'purchase_returns',
      operation: 'UPDATE',
      data: {
        _local_id: returnLocalId,
        total_value: roundedTotal
      }
    });

    // Decrement supplier outstanding balance
    const supplier = await queryOne('suppliers', '(_local_id = ? OR id = ?) AND clinic_id = ?', [supplier_id, supplier_id, clinicId]);
    if (supplier) {
      const currentOutstanding = Number((supplier as any).outstanding_balance ?? 0);
      await localMutate({
        table: 'suppliers',
        operation: 'UPDATE',
        data: {
          _local_id: (supplier as any)._local_id,
          outstanding_balance: Math.max(0, currentOutstanding - roundedTotal)
        }
      });
    }

    res.status(201).json({ data: { ...returnHeader, total_value: roundedTotal } });
  } catch (err: any) {
    next(err);
  }
});

export default purchasesRouter;
