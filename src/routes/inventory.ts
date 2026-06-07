import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createMedicineSchema, updateMedicineSchema } from '../schemas/medicine.schema';
import { disposeBatchSchema } from '../schemas/inventory.schema';
import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import {
  SELLABLE_BATCH_FILTER,
  disposeMedicineBatch,
  listDisposedBatches,
} from '../services/batchDisposal';

export const inventoryRouter = Router();

// GET /api/inventory/medicines/search?q=&barcode=
inventoryRouter.get('/medicines/search', requireAuth, async (req, res, next) => {
  try {
    const q = (req.query.q as string) || '';
    const barcode = (req.query.barcode as string) || '';
    const clinicId = req.user!.clinic_id;

    let results: any[] = [];
    const clinicClause = clinicId ? ' AND clinic_id=?' : '';
    const clinicParams = clinicId ? [clinicId] : [];

    if (barcode) {
      results = await queryAll('medicines', `barcode=? AND is_active=true${clinicClause}`, [barcode, ...clinicParams]);
    } else if (q) {
      results = await queryAll(
        'medicines',
        `(name ILIKE ? OR generic_name ILIKE ?) AND is_active=true${clinicClause}`,
        [`%${q}%`, `%${q}%`, ...clinicParams],
      );
    } else {
      return res.json({ results: [], substitutes: [] });
    }

    // Attach batches to each result
    const medicineIds = results.map(med => med.id);
    if (medicineIds.length > 0) {
      const placeholders = medicineIds.map(() => '?').join(',');
      const batchClinicSql = clinicId ? ' AND clinic_id=?' : '';
      const batchParams = clinicId ? [...medicineIds, clinicId] : medicineIds;
      const allBatches = await queryRaw(
        `SELECT * FROM medicine_batches WHERE medicine_id IN (${placeholders}) AND quantity_remaining > 0 AND deleted_at IS NULL AND ${SELLABLE_BATCH_FILTER}${batchClinicSql} ORDER BY expiry_date ASC`,
        batchParams
      );
      
      for (const med of results) {
        const batches = allBatches.filter(b => b.medicine_id === med.id);
        med.medicine_batches = batches;
        med.total_stock = batches.reduce((s: number, b: any) => s + Number(b.quantity_remaining ?? 0), 0);
      }
    }

    // Find substitutes by generic name
    let substitutes: any[] = [];
    const genericNames = results.map((r: any) => r.generic_name).filter(Boolean);
    if (genericNames.length > 0) {
      const resultIds = results.map((r: any) => r.id);
      const placeholders = genericNames.map(() => '?').join(',');
      const allGeneric = await queryRaw(
        `SELECT * FROM medicines WHERE deleted_at IS NULL AND is_active=true AND generic_name IN (${placeholders})`,
        genericNames
      );
      substitutes = (allGeneric as any[]).filter(s => !resultIds.includes(s.id));
    }

    res.json({ results, substitutes });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/medicines
inventoryRouter.get('/medicines', requireAuth, async (req, res, next) => {
  try {
    const q = req.query.q as string;
    const category = req.query.category as string;
    const lowStock = req.query.low_stock === 'true';
    const scheduleH1 = req.query.schedule_h1 === 'true';

    const clinicId = req.user!.clinic_id;
    const conditions: string[] = ['is_active=true'];
    const values: any[] = [];

    if (clinicId) {
      conditions.push('clinic_id=?');
      values.push(clinicId);
    }

    if (q) { conditions.push('(name ILIKE ? OR generic_name ILIKE ?)'); values.push(`%${q}%`, `%${q}%`); }
    if (category) { conditions.push('category=?'); values.push(category); }
    if (scheduleH1) { conditions.push('is_schedule_h1=true'); }

    const where = conditions.join(' AND ');
    let data = await queryAll('medicines', where, values);

    // Attach stock totals
    if (data.length > 0) {
      const medicineIds = data.map(med => med.id);
      const placeholders = medicineIds.map(() => '?').join(',');
      const batchClinicClause = clinicId ? ' AND clinic_id = ?' : '';
      const batchParams = clinicId ? [...medicineIds, clinicId] : medicineIds;
      const allBatches = await queryRaw(
        `SELECT * FROM medicine_batches WHERE medicine_id IN (${placeholders}) AND quantity_remaining > 0 AND deleted_at IS NULL AND ${SELLABLE_BATCH_FILTER}${batchClinicClause} ORDER BY expiry_date ASC`,
        batchParams
      );

      for (const med of data) {
        const batches = allBatches.filter(b => b.medicine_id === med.id);
        (med as any).medicine_batches = batches;
        (med as any).total_stock = batches.reduce(
          (s: number, b: any) => s + Number(b.quantity_remaining ?? 0),
          0,
        );
      }
    }

    if (lowStock) {
      data = data.filter((d: any) => (d.total_stock ?? 0) <= (d.low_stock_threshold ?? 10));
    }

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/medicines/:id
inventoryRouter.get('/medicines/:id', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const medicine = await queryOne('medicines', '(id=? OR _local_id=?) AND is_active=true AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!medicine) {
      return res.status(404).json({ error: { message: 'Medicine not found', code: 'NOT_FOUND' } });
    }

    const medId = (medicine as any).id;
    const batches = await queryAll('medicine_batches', `medicine_id=? AND ${SELLABLE_BATCH_FILTER}`, [medId]);
    batches.sort((a: any, b: any) => String(a.expiry_date ?? '').localeCompare(String(b.expiry_date ?? '')));

    res.json({ data: { ...medicine, batches } });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/medicines
inventoryRouter.post('/medicines', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const parsed = createMedicineSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: req.user!.clinic_id! };

    const data = await localMutate({ table: 'medicines', operation: 'INSERT', data: payload });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/inventory/medicines/:id
inventoryRouter.put('/medicines/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const parsed = updateMedicineSchema.parse(req.body);
    const payload = { ...parsed, clinic_id: req.user!.clinic_id! };
    const clinicId = req.user!.clinic_id;
    const clinicClause = clinicId ? ' AND clinic_id=?' : '';
    const clinicParams = clinicId ? [clinicId] : [];
    const medicine = await queryOne(
      'medicines',
      `(_local_id=? OR id=?)${clinicClause}`,
      [req.params.id, req.params.id, ...clinicParams],
    );

    if (!medicine) {
      return res.status(404).json({ error: { message: 'Medicine not found', code: 'NOT_FOUND' } });
    }

    const localId = String((medicine as any)._local_id || (medicine as any).id);
    if (!(medicine as any)._local_id) {
      await queryRaw('UPDATE medicines SET _local_id=? WHERE id=? AND _local_id IS NULL', [localId, (medicine as any).id]);
    }

    const data = await localMutate({ table: 'medicines', operation: 'UPDATE', data: { ...payload, _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/inventory/medicines/:id
inventoryRouter.delete('/medicines/:id', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const existing = await queryOne('medicines', '(_local_id=? OR id=?) AND clinic_id=?', [req.params.id, req.params.id, clinicId]);
    if (!existing) {
      return res.status(404).json({ error: 'Medicine not found' });
    }
    const localId = (existing as any)._local_id || (existing as any).id;

    const data = await localMutate({ table: 'medicines', operation: 'DELETE', data: { _local_id: localId } });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/batches/disposed
inventoryRouter.get('/batches/disposed', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id;
    if (!clinicId) {
      return res.status(403).json({ error: { message: 'Clinic context required', code: 'NO_CLINIC' } });
    }
    const data = await listDisposedBatches(clinicId);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/batches/:batchId/dispose
inventoryRouter.post('/batches/:batchId/dispose', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id;
    if (!clinicId) {
      return res.status(403).json({ error: { message: 'Clinic context required', code: 'NO_CLINIC' } });
    }

    const parsed = disposeBatchSchema.parse(req.body);
    const data = await disposeMedicineBatch({
      batchId: req.params.batchId,
      clinicId,
      userId: req.user!.id,
      reason: parsed.reason,
      notes: parsed.notes,
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/batches
inventoryRouter.get('/batches', requireAuth, async (req, res, next) => {
  try {
    const medicineId = req.query.medicine_id as string;
    if (!medicineId) {
      return res.status(400).json({ error: 'medicine_id is required' });
    }

    const clinicId = req.user!.clinic_id!;
    const data = await queryAll('medicine_batches', `medicine_id=? AND clinic_id=? AND ${SELLABLE_BATCH_FILTER}`, [medicineId, clinicId]);
    data.sort((a: any, b: any) => String(a.expiry_date ?? '').localeCompare(String(b.expiry_date ?? '')));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/batches/expiring
inventoryRouter.get('/batches/expiring', requireAuth, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days as string) || 90;
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + days);
    const maxStr = maxDate.toISOString().split('T')[0];
    const clinicId = req.user!.clinic_id!;

    const data = await queryAll(
      'medicine_batches',
      `quantity_remaining>0 AND expiry_date<=? AND clinic_id=? AND ${SELLABLE_BATCH_FILTER}`,
      [maxStr, clinicId],
    );
    data.sort((a: any, b: any) => String(a.expiry_date ?? '').localeCompare(String(b.expiry_date ?? '')));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/stock/low
inventoryRouter.get('/stock/low', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const data = await queryRaw(
      `SELECT m.*, COALESCE(SUM(mb.quantity_remaining), 0) as total_stock
       FROM medicines m
       LEFT JOIN medicine_batches mb ON mb.medicine_id = m.id AND mb.deleted_at IS NULL AND mb.clinic_id = ? AND (mb.is_disposed = false OR mb.is_disposed IS NULL)
       WHERE m.deleted_at IS NULL AND m.is_active=true AND m.clinic_id = ?
       GROUP BY m.id
       HAVING COALESCE(SUM(mb.quantity_remaining), 0) <= COALESCE(m.low_stock_threshold, 10)`,
      [clinicId, clinicId]
    );

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/stock/summary
inventoryRouter.get('/stock/summary', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const medCount = await queryRaw<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM medicines WHERE deleted_at IS NULL AND is_active=true AND clinic_id = ?`,
      [clinicId]
    );

    const batchStats = await queryRaw<{ total_batches: number; total_stock_value: number }>(
      `SELECT COUNT(*) as total_batches, COALESCE(SUM(quantity_remaining * purchase_price), 0) as total_stock_value
       FROM medicine_batches WHERE deleted_at IS NULL AND quantity_remaining>0 AND (is_disposed = false OR is_disposed IS NULL) AND clinic_id = ?`,
      [clinicId]
    );

    res.json({
      data: {
        total_medicines: medCount[0]?.cnt ?? 0,
        total_batches: batchStats[0]?.total_batches ?? 0,
        total_stock_value: batchStats[0]?.total_stock_value ?? 0
      }
    });
  } catch (err) {
    next(err);
  }
});

export default inventoryRouter;
