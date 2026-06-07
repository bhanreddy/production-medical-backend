import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createExpenseSchema, updateExpenseSchema } from '../schemas/expense.schema';
import sql from '../db';
import { broadcastToClinic } from '../lib/sseManager';

export const expensesRouter = Router();

// GET /api/expenses/summary
expensesRouter.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const from = req.query.from as string;
    const to = req.query.to as string;

    const values: any[] = [];
    const conditions = [
      'deleted_at IS NULL',
      'clinic_id=$' + (values.push(req.user!.clinic_id!))
    ];
    if (from) { conditions.push('expense_date>=$' + (values.push(from))); }
    if (to) { conditions.push('expense_date<=$' + (values.push(to))); }

    const queryStr = `SELECT category, SUM(amount) as total, COUNT(*) as cnt FROM expenses WHERE ${conditions.join(' AND ')} GROUP BY category`;
    const rows = await sql.unsafe(queryStr, values);

    const grand_total = rows.reduce((a, r) => a + Number(r.total), 0);

    res.json({ data: { summary: rows.map(r => ({ category: r.category, total: Number(r.total), count: Number(r.cnt) })), grand_total } });
  } catch (err) {
    next(err);
  }
});

// GET /api/expenses
expensesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const values: any[] = [];
    const conditions: string[] = [
      'deleted_at IS NULL',
      'clinic_id=$' + (values.push(req.user!.clinic_id!))
    ];
    if (req.query.category) { conditions.push('category=$' + (values.push(req.query.category))); }
    if (req.query.from) { conditions.push('expense_date>=$' + (values.push(req.query.from))); }
    if (req.query.to) { conditions.push('expense_date<=$' + (values.push(req.query.to))); }
    if (req.query.payment_mode) { conditions.push('payment_mode=$' + (values.push(req.query.payment_mode))); }

    const where = conditions.join(' AND ');
    const countQuery = `SELECT COUNT(*)::int as cnt FROM expenses WHERE ${where}`;
    const countRows = await sql.unsafe(countQuery, values);
    const total = countRows[0]?.cnt || 0;

    const offset = (page - 1) * limit;
    const dataValues = [...values];
    const paramLimitIdx = dataValues.push(limit);
    const paramOffsetIdx = dataValues.push(offset);
    const paginatedQueryStr = `SELECT * FROM expenses WHERE ${where} ORDER BY expense_date DESC LIMIT $${paramLimitIdx} OFFSET $${paramOffsetIdx}`;
    const data = await sql.unsafe(paginatedQueryStr, dataValues);

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses
expensesRouter.post('/', requireAuth, requireRole('OWNER', 'PHARMACIST'), async (req, res, next) => {
  try {
    const parsed = createExpenseSchema.parse(req.body);
    const payload = {
      ...parsed,
      clinic_id: req.user!.clinic_id!,
      recorded_by: req.user!.id,
      _local_id: req.body._local_id || crypto.randomUUID(),
      updated_at: new Date().toISOString(),
    };

    const [data] = await sql<any[]>`
      INSERT INTO expenses ${sql(payload)}
      RETURNING *
    `;

    // Broadcast to all connected SSE clients for this clinic
    broadcastToClinic(req.user!.clinic_id!, {
      type: 'EXPENSE_ADDED',
      payload: data,
    });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/:id
expensesRouter.put('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const parsed = updateExpenseSchema.parse(req.body);
    const payload = {
      ...parsed,
      updated_at: new Date().toISOString(),
    };

    const [data] = await sql<any[]>`
      UPDATE expenses
      SET ${sql(payload)}
      WHERE _local_id = ${req.params.id} AND clinic_id = ${req.user!.clinic_id!}
      RETURNING *
    `;

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/expenses/:id
expensesRouter.delete('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    await sql`
      UPDATE expenses
      SET deleted_at = ${now}, updated_at = ${now}
      WHERE (_local_id = ${req.params.id} OR id::text = ${req.params.id}) AND clinic_id = ${req.user!.clinic_id!}
    `;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default expensesRouter;
