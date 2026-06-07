import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { addToShortbookSchema } from '../schemas/shortbook.schema';

export const shortbookRouter = Router();

// GET /api/shortbook
shortbookRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const data = await queryRaw('SELECT * FROM shortbook WHERE is_ordered=false AND clinic_id=?', [clinicId]);
    data.sort((a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/shortbook
shortbookRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = addToShortbookSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: req.user!.clinic_id! };

    const data = await localMutate({ table: 'shortbook', operation: 'INSERT', data: payload });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shortbook/:id/ordered
shortbookRouter.patch('/:id/ordered', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('shortbook', '(_local_id = ? OR id = ?) AND clinic_id = ?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Shortbook item not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const data = await localMutate({
      table: 'shortbook',
      operation: 'UPDATE',
      data: { is_ordered: true, ordered_at: new Date().toISOString(), _local_id: localId }
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shortbook/:id
shortbookRouter.delete('/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const result = await queryRaw('DELETE FROM shortbook WHERE (_local_id = ? OR id = ?) AND clinic_id = ?', [req.params.id, req.params.id, clinicId]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default shortbookRouter;
