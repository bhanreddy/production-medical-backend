import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createSaleSchema, saleReturnSchema } from '../schemas/sale.schema';
import { AppError } from '../lib/appError';

export const salesRouter = Router();

// GET /api/sales
salesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const customer_id = req.query.customer_id as string;
    const medicine_id = req.query.medicine_id as string;
    const from = req.query.from as string;
    const to = req.query.to as string;
    const payment_status = req.query.payment_status as string;

    const clinicId = req.user!.clinic_id!;
    const conditions: string[] = ['clinic_id=?'];
    const values: any[] = [clinicId];

    if (medicine_id) {
      const med = await queryOne('medicines', '(_local_id=? OR id=?) AND clinic_id=?', [medicine_id, medicine_id, clinicId]);
      const resolvedMedicineId = med ? (med as any).id : medicine_id;
      conditions.push('id IN (SELECT sale_id FROM sale_items WHERE _deleted=0 AND medicine_id=?)');
      values.push(resolvedMedicineId);
    }
    if (customer_id) { conditions.push('customer_id=?'); values.push(customer_id); }
    if (payment_status) { conditions.push('payment_status=?'); values.push(payment_status); }
    if (from) { conditions.push('created_at>=?'); values.push(from); }
    if (to) { conditions.push('created_at<=?'); values.push(to); }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '';
    const total = await queryCount('sales', where, values);
    const offset = (page - 1) * limit;

    let queryStr = `SELECT * FROM sales WHERE _deleted = 0`;
    if (where) {
      queryStr += ` AND (${where})`;
    }
    queryStr += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;

    const data = await queryRaw(queryStr, [...values, limit, offset]);

    // Attach customer name (in batch)
    const customerIds = data.map((sale: any) => sale.customer_id).filter(Boolean);
    if (customerIds.length > 0) {
      const placeholders = customerIds.map(() => '?').join(',');
      const customers = await queryRaw(
        `SELECT id, _local_id, name FROM customers WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...customerIds, ...customerIds]
      );
      const customerMap = new Map();
      for (const cust of customers) {
        customerMap.set(cust.id, cust);
        customerMap.set(cust._local_id, cust);
      }
      for (const sale of data) {
        if (sale.customer_id) {
          const cust = customerMap.get(sale.customer_id);
          sale.customers = { name: cust?.name ?? '' };
        } else {
          sale.customers = { name: '' };
        }
      }
    } else {
      for (const sale of data) {
        sale.customers = { name: '' };
      }
    }

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/sales/:id
salesRouter.get('/:id', requireAuth, async (req, res, next) => {
  if (req.params.id === 'returns') return next();
  try {
    const clinicId = req.user!.clinic_id!;
    const sale = await queryOne('sales', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const saleId = (sale as any).id;
    const saleItems = await queryAll('sale_items', 'sale_id=?', [saleId]);

    // Attach medicine names and batch numbers (in batch)
    const medicineIds = saleItems.map((item: any) => item.medicine_id).filter(Boolean);
    const batchIds = saleItems.map((item: any) => item.batch_id).filter(Boolean);

    let medicineMap = new Map();
    if (medicineIds.length > 0) {
      const placeholders = medicineIds.map(() => '?').join(',');
      const medicines = await queryRaw(
        `SELECT id, _local_id, name FROM medicines WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...medicineIds, ...medicineIds]
      );
      for (const med of medicines) {
        medicineMap.set(med.id, med);
        medicineMap.set(med._local_id, med);
      }
    }

    let batchMap = new Map();
    if (batchIds.length > 0) {
      const placeholders = batchIds.map(() => '?').join(',');
      const batches = await queryRaw(
        `SELECT id, _local_id, batch_number, expiry_date FROM medicine_batches WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...batchIds, ...batchIds]
      );
      for (const b of batches) {
        batchMap.set(b.id, b);
        batchMap.set(b._local_id, b);
      }
    }

    for (const item of saleItems) {
      if (item.medicine_id) {
        const med = medicineMap.get(item.medicine_id);
        item.medicines = { name: med?.name ?? '' };
      } else {
        item.medicines = { name: '' };
      }
      if (item.batch_id) {
        const batch = batchMap.get(item.batch_id);
        item.medicine_batches = { batch_number: batch?.batch_number ?? '', expiry_date: batch?.expiry_date ?? '' };
      } else {
        item.medicine_batches = { batch_number: '', expiry_date: '' };
      }
    }

    res.json({ data: { ...sale, sale_items: saleItems } });
  } catch (err) {
    next(err);
  }
});

import { enforcePlan } from '../middleware/planEnforcement';

// POST /api/sales
salesRouter.post('/', requireAuth, requireRole('PHARMACIST', 'CASHIER', 'OWNER'), enforcePlan, async (req, res, next) => {
  try {
    const parsed = createSaleSchema.parse(req.body);
    const clinicId = req.user!.clinic_id!;

    // Stock Validation & ID Resolution Map
    const resolvedIdsMap = new Map<string, { resolvedMedicineId: string; resolvedBatchId: string }>();
    for (const item of parsed.items) {
      const batch = await queryOne('medicine_batches', '(_local_id=? OR id=?) AND clinic_id=?', [item.batch_id, item.batch_id, clinicId]);
      if (!batch) throw new AppError(404, `Batch not found: ${item.batch_id}`, 'BATCH_NOT_FOUND');
      if ((batch as any).is_disposed === true || (batch as any).is_disposed === 1) {
        throw new AppError(400, `Batch is disposed and cannot be sold: ${item.batch_id}`, 'BATCH_DISPOSED');
      }

      const med = await queryOne('medicines', '(_local_id=? OR id=?) AND clinic_id=?', [item.medicine_id, item.medicine_id, clinicId]);
      if (!med) throw new AppError(404, `Medicine not found: ${item.medicine_id}`, 'MEDICINE_NOT_FOUND');

      if (Number((batch as any).quantity_remaining ?? 0) < item.quantity) {
        throw new AppError(
          409,
          `Insufficient stock for ${(med as any).name}. Available: ${(batch as any).quantity_remaining}, Requested: ${item.quantity}`,
          'INSUFFICIENT_STOCK',
        );
      }

      resolvedIdsMap.set(`${item.medicine_id}:${item.batch_id}`, {
        resolvedMedicineId: med.id,
        resolvedBatchId: batch.id
      });
    }

    // Calculations
    let subtotal = 0;
    let gst_amount = 0;
    const sItemsToInsert = [];

    for (const item of parsed.items) {
      const itemTotal = item.quantity * item.mrp * (1 - item.discount_pct / 100);
      subtotal += itemTotal;
      gst_amount += (item.quantity * item.mrp * item.gst_rate) / 100;
      
      const resolved = resolvedIdsMap.get(`${item.medicine_id}:${item.batch_id}`)!;

      sItemsToInsert.push({
        clinic_id: clinicId,
        medicine_id: resolved.resolvedMedicineId,
        batch_id: resolved.resolvedBatchId,
        quantity: item.quantity,
        mrp: item.mrp,
        discount_pct: item.discount_pct,
        gst_rate: item.gst_rate,
        total: itemTotal
      });
    }

    const net_amount = subtotal - parsed.discount + gst_amount;
    const balance_due = Math.max(net_amount - parsed.paid_amount, 0);

    // Resolve customer_id
    let customerId = null;
    if (parsed.customer_id) {
      const cust = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [parsed.customer_id, parsed.customer_id, clinicId]);
      if (cust) {
        customerId = (cust as any).id;
      }
    }

    // Insert Sale locally
    const sale = await localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        customer_id: customerId,
        invoice_number: `LOCAL-${Date.now()}`,
        subtotal,
        discount: parsed.discount,
        gst_amount,
        net_amount,
        payment_mode: parsed.payment_mode,
        payment_status: parsed.payment_status,
        paid_amount: parsed.paid_amount,
        balance_due,
        served_by: req.user!.id,
      }
    });

    // Insert Sale Items + deduct stock
    const finalItems = sItemsToInsert.map(i => ({ ...i, sale_id: sale.id }));
    for (const item of finalItems) {
      await localMutate({ table: 'sale_items', operation: 'INSERT', data: item });

      // Immediately deduct stock
      const batch = await queryOne('medicine_batches', '(_local_id=? OR id=?) AND clinic_id=?', [item.batch_id, item.batch_id, clinicId]);
      if (batch) {
        await localMutate({
          table: 'medicine_batches',
          operation: 'UPDATE',
          data: {
            _local_id: (batch as any)._local_id,
            quantity_remaining: Math.max(0, Number((batch as any).quantity_remaining) - item.quantity),
          }
        });
      }
    }

    res.status(201).json({ data: { ...sale, sale_items: finalItems } });
  } catch (err) {
    next(err);
  }
});

// POST /api/sales/returns
salesRouter.post('/returns', requireAuth, requireRole('PHARMACIST', 'OWNER'), async (req, res, next) => {
  try {
    const parsed = saleReturnSchema.parse(req.body);
    const clinicId = req.user!.clinic_id!;

    // Resolve original_sale_id
    let returnOfId = null;
    if (parsed.original_sale_id) {
      const origSale = await queryOne('sales', '(_local_id=? OR id=?) AND clinic_id=?', [parsed.original_sale_id, parsed.original_sale_id, clinicId]);
      if (origSale) {
        returnOfId = (origSale as any).id;
      }
    }

    // Insert return sale locally
    const returnSale = await localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        invoice_number: `RET-LOCAL-${Date.now()}`,
        is_return: true,
        return_of: returnOfId,
        served_by: req.user!.id,
      }
    });

    // Insert return items + restore stock
    for (const retItem of parsed.items) {
      const origItem = await queryOne('sale_items', '_local_id=? OR id=?', [retItem.sale_item_id, retItem.sale_item_id]);
      if (!origItem) {
        throw new Error(`Original sale item ${retItem.sale_item_id} not found`);
      }
      
      const parentSale = await queryOne('sales', 'id=? AND clinic_id=?', [(origItem as any).sale_id, clinicId]);
      if (!parentSale) {
        throw new Error(`Original sale item ${retItem.sale_item_id} not found`);
      }
      
      const resolvedSaleItemId = (origItem as any).id;

      await localMutate({
        table: 'sale_items',
        operation: 'INSERT',
        data: {
          clinic_id: clinicId,
          sale_id: returnSale.id,
          sale_item_id: resolvedSaleItemId,
          quantity: retItem.quantity,
          reason: retItem.reason,
        }
      });

      // Restore batch stock
      if ((origItem as any).batch_id) {
        const batch = await queryOne('medicine_batches', '(_local_id=? OR id=?) AND clinic_id=?', [(origItem as any).batch_id, (origItem as any).batch_id, clinicId]);
        if (batch) {
          await localMutate({
            table: 'medicine_batches',
            operation: 'UPDATE',
            data: {
              _local_id: (batch as any)._local_id,
              quantity_remaining: Number((batch as any).quantity_remaining) + retItem.quantity,
            }
          });
        }
      }
    }

    res.json({ data: returnSale });
  } catch (err) {
    next(err);
  }
});

// GET /api/sales/:id/invoice
salesRouter.get('/:id/invoice', requireAuth, async (req, res, next) => {
  try {
    const sale = await queryOne('sales', '_local_id=? OR id=?', [req.params.id, req.params.id]) as any;
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const saleItems = await queryAll('sale_items', 'sale_id=?', [sale.id]);
    const clinic = await queryOne('clinics', '1=1') as any;

    // Attach medicine names
    for (const item of saleItems) {
      if ((item as any).medicine_id) {
        const med = await queryOne('medicines', '_local_id=? OR id=?', [(item as any).medicine_id, (item as any).medicine_id]);
        (item as any).medicines = { name: (med as any)?.name ?? '' };
      }
      if ((item as any).batch_id) {
        const batch = await queryOne('medicine_batches', '_local_id=? OR id=?', [(item as any).batch_id, (item as any).batch_id]);
        (item as any).medicine_batches = { batch_number: (batch as any)?.batch_number ?? '', expiry_date: (batch as any)?.expiry_date ?? '' };
      }
    }

    let customerName = 'Walk-in';
    if (sale.customer_id) {
      const cust = await queryOne('customers', '_local_id=? OR id=?', [sale.customer_id, sale.customer_id]);
      customerName = (cust as any)?.name ?? 'Walk-in';
    }

    const html = `
      <html>
        <head>
          <style>
            body { font-family: 'Helvetica', sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            .right { text-align: right; }
          </style>
        </head>
        <body>
          <h2>${clinic?.name ?? 'Medical Store'}</h2>
          <p>${clinic?.address || ''}<br/>GSTIN: ${clinic?.gstin || 'N/A'}<br/>DL No: ${clinic?.drug_licence_number || 'N/A'}</p>
          <hr />
          <h3>Invoice #${sale.invoice_number}</h3>
          <p>Date: ${sale.created_at}<br/>
             Customer: ${customerName}</p>
          <table>
             <tr><th>Item</th><th>Batch/Exp</th><th>Qty</th><th>MRP</th><th>Total</th></tr>
             ${(saleItems as any[]).map(i => `
                <tr>
                  <td>${i.medicines?.name ?? ''}</td>
                  <td>${i.medicine_batches?.batch_number ?? ''} / ${i.medicine_batches?.expiry_date ?? ''}</td>
                  <td>${i.quantity}</td>
                  <td>${i.mrp}</td>
                  <td class="right">${i.total}</td>
                </tr>
             `).join('')}
             <tr><th colspan="4" class="right">Subtotal</th><th class="right">${sale.subtotal}</th></tr>
             <tr><th colspan="4" class="right">Discount</th><th class="right">${sale.discount}</th></tr>
             <tr><th colspan="4" class="right">GST</th><th class="right">${sale.gst_amount}</th></tr>
             <tr><th colspan="4" class="right"><strong>Grand Total</strong></th><th class="right"><strong>${sale.net_amount}</strong></th></tr>
          </table>
          <p style="margin-top:20px; font-size:12px;">${clinic?.invoice_footer || ''}</p>
        </body>
      </html>
    `;

    res.json({ data: { html, sale: { ...sale, sale_items: saleItems }, clinic } });
  } catch (err) {
    next(err);
  }
});

export default salesRouter;
