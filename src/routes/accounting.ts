import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { queryRaw } from '../lib/postgresDb';
import { buildAccountingSummary } from '../lib/accountingSummary';

export const accountingRouter = Router();

// GET /api/accounting/summary
accountingRouter.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const { from, to } = req.query;
    const summary = await buildAccountingSummary(
      clinicId,
      from as string | undefined,
      to as string | undefined,
    );
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounting/transactions
accountingRouter.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;

    const [sales, expenses, purchases] = await Promise.all([
      queryRaw<Record<string, unknown>>(
        `SELECT _local_id as id, 'sale' as type, invoice_number as ref, net_amount as amount, created_at as date
         FROM sales WHERE deleted_at IS NULL AND clinic_id = ? ORDER BY created_at DESC LIMIT 50`,
        [clinicId],
      ),
      queryRaw<Record<string, unknown>>(
        `SELECT _local_id as id, 'expense' as type, category as ref, amount, expense_date as date
         FROM expenses WHERE deleted_at IS NULL AND clinic_id = ? ORDER BY expense_date DESC LIMIT 50`,
        [clinicId],
      ),
      queryRaw<Record<string, unknown>>(
        `SELECT _local_id as id, 'purchase' as type, invoice_number as ref, net_amount as amount, created_at as date
         FROM purchases WHERE deleted_at IS NULL AND clinic_id = ? ORDER BY created_at DESC LIMIT 50`,
        [clinicId],
      ),
    ]);

    const all = [...sales, ...expenses, ...purchases];
    all.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

    res.json({ data: all.slice(0, 50) });
  } catch (err) {
    next(err);
  }
});

export default accountingRouter;
