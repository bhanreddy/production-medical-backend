import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  createCustomerSchema,
  updateCustomerSchema,
  recordPaymentSchema,
  createRefillReminderSchema,
} from '../schemas/customer.schema';



export const customersRouter = Router();

async function listDueReminders(req: Request, res: Response, next: NextFunction) {
  try {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + 3);
    const thresholdStr = threshold.toISOString().split('T')[0];
    const clinicId = req.user!.clinic_id!;

    const data = await queryAll(
      'refill_reminders',
      'clinic_id=? AND (is_sent=false OR is_sent IS NULL) AND remind_on<=?',
      [clinicId, thresholdStr],
    );

    res.json({ data });
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/due-reminders (mobile alias — must be before /:id)
customersRouter.get('/due-reminders', requireAuth, listDueReminders);

// GET /api/customers
customersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const q = req.query.q as string;

    const clinicId = req.user!.clinic_id!;
    const conditions: string[] = ['clinic_id=?'];
    const values: any[] = [clinicId];
    if (q) { conditions.push('name ILIKE ?'); values.push(`%${q}%`); }

    const where = conditions.length > 0 ? conditions.join(' AND ') : '';
    const total = await queryCount('customers', where, values);
    const offset = (page - 1) * limit;

    let queryStr = `SELECT * FROM customers WHERE _deleted = 0`;
    if (where) {
      queryStr += ` AND (${where})`;
    }
    queryStr += ` ORDER BY COALESCE(importance_score, 0) DESC LIMIT ? OFFSET ?`;

    const data = await queryRaw(queryStr, [...values, limit, offset]);

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id
customersRouter.get('/:id', requireAuth, async (req, res, next) => {
  if (req.params.id === 'reminders' || req.params.id === 'due-reminders') return next();

  try {
    const clinicId = req.user!.clinic_id!;
    const customer = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const custId = (customer as any).id;
    const sales = await queryAll('sales', 'customer_id=? AND clinic_id=?', [custId, clinicId]);
    sales.sort((a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const recent_sales = sales.slice(0, 10);

    res.json({ data: { ...customer, recent_sales } });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers
customersRouter.post('/', requireAuth, requireRole('PHARMACIST', 'OWNER'), async (req, res, next) => {
  try {
    const parsed = createCustomerSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: req.user!.clinic_id! };

    const data = await localMutate({ table: 'customers', operation: 'INSERT', data: payload });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customers/:id
customersRouter.put('/:id', requireAuth, requireRole('PHARMACIST', 'OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const parsed = updateCustomerSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: clinicId };

    const data = await localMutate({ table: 'customers', operation: 'UPDATE', data: { ...payload, _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id
customersRouter.delete('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const data = await localMutate({ table: 'customers', operation: 'DELETE', data: { _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/outstanding
customersRouter.get('/:id/outstanding', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const customer = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const custId = (customer as any).id;
    const creditSales = await queryAll('sales', "customer_id=? AND clinic_id=? AND payment_status IN ('credit','partial')", [custId, clinicId]);

    res.json({ data: { outstanding_balance: (customer as any).outstanding_balance, credit_sales: creditSales } });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/payment
customersRouter.post('/:id/payment', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const parsed = recordPaymentSchema.parse(req.body);

    const data = await localMutate({
      table: 'customers',
      operation: 'UPDATE',
      data: { payment_amount: parsed.amount, payment_mode: parsed.payment_mode, _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/reminders
customersRouter.post(
  '/reminders',
  requireAuth,
  requireRole('PHARMACIST', 'OWNER'),
  async (req, res, next) => {
    try {
      const parsed = createRefillReminderSchema.parse(req.body);
      const clinicId = req.user!.clinic_id!;

      const customer = await queryOne('customers', '(_local_id=? OR id=?) AND clinic_id=?', [parsed.customer_id, parsed.customer_id, clinicId]);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      const resolvedCustomerId = (customer as any).id;

      const data = await localMutate({
        table: 'refill_reminders',
        operation: 'INSERT',
        data: {
          clinic_id: clinicId,
          customer_id: resolvedCustomerId,
          medicine_name: parsed.medicine_name,
          remind_on: parsed.reminder_date,
        }
      });

      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/customers/reminders/due
customersRouter.get('/reminders/due', requireAuth, listDueReminders);

// PATCH /api/customers/reminders/:id/sent
customersRouter.patch('/reminders/:id/sent', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('refill_reminders', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const data = await localMutate({
      table: 'refill_reminders',
      operation: 'UPDATE',
      data: { is_sent: true, sent_at: new Date().toISOString(), _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export default customersRouter;
