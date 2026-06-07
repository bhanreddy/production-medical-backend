import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { 
  createSupplierSchema, 
  updateSupplierSchema 
} from '../schemas/supplier.schema';



export const suppliersRouter = Router();

// GET /api/suppliers
suppliersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const q = req.query.q as string;

    const clinicId = req.user!.clinic_id!;
    const conditions: string[] = ['clinic_id=?'];
    const values: any[] = [clinicId];
    if (q) { conditions.push('name ILIKE ?'); values.push(`%${q}%`); }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '';
    const total = await queryCount('suppliers', where, values);
    const offset = (page - 1) * limit;

    let queryStr = `SELECT * FROM suppliers WHERE _deleted = 0`;
    if (where) {
      queryStr += ` AND (${where})`;
    }
    queryStr += ` ORDER BY name ASC LIMIT ? OFFSET ?`;

    const data = await queryRaw(queryStr, [...values, limit, offset]);

    res.json({
      data,
      pagination: { 
        page, 
        limit, 
        total, 
        totalPages: Math.ceil(total / limit) 
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/suppliers/:id
suppliersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const data = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!data) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/suppliers
suppliersRouter.post('/', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const parsed = createSupplierSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: req.user!.clinic_id! };

    const data = await localMutate({ table: 'suppliers', operation: 'INSERT', data: payload });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/suppliers/:id
suppliersRouter.put('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const parsed = updateSupplierSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: clinicId };

    const data = await localMutate({ table: 'suppliers', operation: 'UPDATE', data: { ...payload, _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/suppliers/:id
suppliersRouter.delete('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const data = await localMutate({ table: 'suppliers', operation: 'DELETE', data: { _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/suppliers/:id/outstanding
suppliersRouter.get('/:id/outstanding', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const supplier = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const suppId = (supplier as any).id;
    const purchases = await queryAll('purchases', "supplier_id=? AND clinic_id=? AND payment_status!='paid'", [suppId, clinicId]);
    purchases.sort((a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

    res.json({ data: { outstanding_balance: (supplier as any).outstanding_balance, purchases: purchases.slice(0, 10) } });
  } catch (err) {
    next(err);
  }
});

// POST /api/suppliers/:id/payment
suppliersRouter.post('/:id/payment', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('suppliers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const amountStr = req.body.amount;
    const amount = Number(amountStr);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount required' });
    }

    const data = await localMutate({
      table: 'suppliers',
      operation: 'UPDATE',
      data: { payment_amount: amount, _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export default suppliersRouter;
