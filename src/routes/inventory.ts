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
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const clinicId = req.user!.clinic_id;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 25, 100));
    const clinicClause = clinicId ? ' AND clinic_id=?' : '';
    const clinicParams = clinicId ? [clinicId] : [];
    let searchSql: string;
    let searchParams: any[];

    if (barcode) {
      searchSql = `SELECT * FROM medicines WHERE deleted_at IS NULL AND barcode=? AND is_active=true${clinicClause}
         ORDER BY name, id LIMIT ?`;
      searchParams = [barcode, ...clinicParams, limit];
    } else if (q) {
      const literal = q.replace(/[\\%_]/g, '\\$&');
      searchSql = `SELECT * FROM medicines WHERE deleted_at IS NULL
           AND (name ILIKE ? OR generic_name ILIKE ?) AND is_active=true${clinicClause}
         ORDER BY CASE WHEN LOWER(name)=LOWER(?) THEN 0 WHEN name ILIKE ? THEN 1 ELSE 2 END,
                  name, id LIMIT ?`;
      searchParams = [`%${literal}%`, `%${literal}%`, ...clinicParams, q, `${literal}%`, limit];
    } else {
      return res.json({ results: [], substitutes: [] });
    }

    // POS needs the ranked page plus sellable FEFO snapshots, not substitutes.
    // A lateral aggregate returns both in one database round trip.
    if (req.query.include_substitutes === 'false') {
      const results = await queryRaw(
        `WITH page AS MATERIALIZED (${searchSql})
         SELECT page.*, stock.medicine_batches, stock.total_stock FROM page
         LEFT JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.expiry_date, b.id), '[]'::jsonb) AS medicine_batches,
                  COALESCE(SUM(b.quantity_remaining), 0) AS total_stock
           FROM medicine_batches b WHERE
             (b.medicine_id = page.id OR b.medicine_id = CASE
               WHEN page._local_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN page._local_id::text::uuid ELSE NULL END)
             AND b.clinic_id = page.clinic_id AND b.deleted_at IS NULL
             AND b.quantity_remaining > 0 AND (b.is_disposed = false OR b.is_disposed IS NULL)
             AND b.expiry_date >= ?
         ) stock ON true
         ORDER BY ${barcode ? '' : 'CASE WHEN LOWER(page.name)=LOWER(?) THEN 0 WHEN page.name ILIKE ? THEN 1 ELSE 2 END,'}
                  page.name, page.id`,
        [...searchParams, new Date().toISOString().split('T')[0], ...(barcode ? [] : [q, `${q.replace(/[\\%_]/g, '\\$&')}%`])],
      );
      return res.json({ results, substitutes: [] });
    }
    const results = await queryRaw(searchSql, searchParams);

    // One stock read for the bounded page; group once instead of filtering for every product.
    const medicineIds = [...new Set(results.flatMap(med => [med.id, med._local_id]).filter(Boolean))];
    if (medicineIds.length > 0) {
      const placeholders = medicineIds.map(() => '?').join(',');
      const today = new Date().toISOString().split('T')[0];
      const allBatches = await queryRaw(
        `SELECT * FROM medicine_batches WHERE medicine_id IN (${placeholders})
         AND quantity_remaining > 0 AND deleted_at IS NULL AND ${SELLABLE_BATCH_FILTER}
         AND expiry_date >= ?${clinicClause} ORDER BY expiry_date ASC, id ASC`,
        [...medicineIds, today, ...clinicParams]);
      const grouped = new Map<string, any[]>();
      for (const batch of allBatches) {
        const group = grouped.get(batch.medicine_id);
        if (group) group.push(batch);
        else grouped.set(batch.medicine_id, [batch]);
      }
      for (const med of results) {
        const batches = [...(grouped.get(med.id) || [])];
        if (med._local_id !== med.id) batches.push(...(grouped.get(med._local_id) || []));
        batches.sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
        med.medicine_batches = batches;
        med.total_stock = batches.reduce((sum, batch) => sum + Number(batch.quantity_remaining || 0), 0);
      }
    }

    // Billing does not render these; other consumers can still request substitutes.
    let substitutes: any[] = [];
    const genericNames = [...new Set(results.map(med => med.generic_name).filter(Boolean))];
    if (req.query.include_substitutes !== 'false' && genericNames.length > 0) {
      const placeholders = genericNames.map(() => '?').join(',');
      const resultIds = new Set(results.map(med => med.id));
      const allGeneric = await queryRaw(
        `SELECT * FROM medicines WHERE deleted_at IS NULL AND is_active=true
         AND generic_name IN (${placeholders})${clinicClause} ORDER BY name, id LIMIT 100`,
        [...genericNames, ...clinicParams]);
      substitutes = allGeneric.filter(med => !resultIds.has(med.id)).slice(0, 15);
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
    const batchClinicClause = clinicId ? ' AND clinic_id = ?' : '';
    // Selecting batches by the same filter (not by the fetched ids) lets both reads run concurrently.
    const [medicines, allBatches] = await Promise.all([
      queryAll('medicines', where, values),
      queryRaw(
        `SELECT * FROM medicine_batches
         WHERE medicine_id IN (SELECT id FROM medicines WHERE deleted_at IS NULL AND (${where}))
           AND quantity_remaining > 0 AND deleted_at IS NULL AND ${SELLABLE_BATCH_FILTER}${batchClinicClause}
         ORDER BY expiry_date ASC`,
        clinicId ? [...values, clinicId] : values,
      ),
    ]);

    // Attach stock totals
    const batchesByMedicine = new Map<string, any[]>();
    for (const batch of allBatches) {
      const group = batchesByMedicine.get(batch.medicine_id);
      if (group) group.push(batch);
      else batchesByMedicine.set(batch.medicine_id, [batch]);
    }
    let data = medicines;
    for (const med of data) {
      const batches = batchesByMedicine.get(med.id) || [];
      (med as any).medicine_batches = batches;
      (med as any).total_stock = batches.reduce(
        (s: number, b: any) => s + Number(b.quantity_remaining ?? 0),
        0,
      );
    }

    if (lowStock) {
      data = data.filter((d: any) => (d.total_stock ?? 0) <= (d.low_stock_threshold ?? 10));
    }

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/attention-counts?today=YYYY-MM-DD&warning=YYYY-MM-DD
// Header badges. Same batch rules as the inventory screen, without sending the whole catalog.
inventoryRouter.get('/attention-counts', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id;
    if (!clinicId) return res.status(400).json({ error: 'No clinic associated with this account.' });
    const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const today = isDay(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
    let warning = isDay(req.query.warning) ? req.query.warning : '';
    if (!warning || warning < today) {
      const fallback = new Date(`${today}T00:00:00Z`);
      fallback.setUTCDate(fallback.getUTCDate() + 30);
      warning = fallback.toISOString().slice(0, 10);
    }
    const [row] = await queryRaw<{ low_stock: number; expiring: number; shortbook: number }>(
      `WITH batches AS (
         SELECT mb.quantity_remaining AS qty, mb.expiry_date,
                GREATEST(COALESCE(m.low_stock_threshold, 10), 1) AS min_alert
         FROM medicine_batches mb
         JOIN medicines m ON m.id = mb.medicine_id
         WHERE m.clinic_id = ? AND m.deleted_at IS NULL AND m.is_active = true
           AND mb.clinic_id = ? AND mb.deleted_at IS NULL AND mb.quantity_remaining > 0
           AND (mb.is_disposed = false OR mb.is_disposed IS NULL)
       )
       SELECT
         COUNT(*) FILTER (
           WHERE expiry_date >= ?::date AND (qty < min_alert OR (min_alert = 1 AND qty <= 1))
         )::int AS low_stock,
         COUNT(*) FILTER (
           WHERE expiry_date < ?::date
              OR (expiry_date >= ?::date AND expiry_date <= ?::date
                  AND NOT (qty < min_alert OR (min_alert = 1 AND qty <= 1)))
         )::int AS expiring,
         (SELECT COUNT(*)::int FROM shortbook WHERE clinic_id = ? AND is_ordered = false) AS shortbook
       FROM batches`,
      [clinicId, clinicId, today, today, today, warning, clinicId],
    );
    res.json({
      data: {
        low_stock: Number(row?.low_stock ?? 0),
        expiring: Number(row?.expiring ?? 0),
        shortbook: Number(row?.shortbook ?? 0),
      },
    });
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
    const medicineId = typeof req.query.medicine_id === 'string' ? req.query.medicine_id : null;
    const clinicId = req.user!.clinic_id!;
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || 100)) || 100, 1000));
    const includeUnavailable = req.query.include_unavailable === 'true';
    const conditions = ['clinic_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [clinicId];
    if (medicineId) { conditions.push('medicine_id = ?'); params.push(medicineId); }
    if (!includeUnavailable) conditions.push(SELLABLE_BATCH_FILTER);
    params.push(limit);
    const data = await queryRaw(`SELECT * FROM medicine_batches WHERE ${conditions.join(' AND ')} ORDER BY expiry_date ASC, id ASC LIMIT ?`, params);

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

// ──────────────────────────────────────────
// TASK 5: ADVANCED INVENTORY INTELLIGENCE ROUTES
// ──────────────────────────────────────────

import { InventoryAvailabilityService } from '../services/inventory/inventoryAvailabilityService';
import { StocktakeEngine } from '../services/inventory/stocktakeEngine';
import { InventoryReconciliationServiceV2 } from '../services/inventory/inventoryReconciliationV2';
import { InventoryClassificationEngine } from '../services/inventory/inventoryClassificationEngine';
import { ExpiryIntelligenceEngine } from '../services/inventory/expiryIntelligenceEngine';
import { ProductRecallEngine } from '../services/inventory/productRecallEngine';
import { InventoryReservationService } from '../services/inventory/inventoryReservationService';
import { ReorderEngine } from '../services/inventory/reorderEngine';
import { InventoryAlertEngine } from '../services/inventory/inventoryAlertEngine';
import { InventoryValuationService } from '../services/inventory/inventoryValuationService';
import { localDb } from '../local-db';

// Helper to resolve org and store from auth user
function resolveOrgAndStore(req: any) {
  const orgId = req.user?.organization_id || req.user?.clinic_id || 'default-org';
  const storeId = req.user?.store_id || req.query.store_id || null;
  const warehouseId = req.query.warehouse_id || null;
  return { orgId, storeId, warehouseId };
}

// GET /api/inventory/availability?medicine_id=&batch_id=&store_id=
inventoryRouter.get('/availability', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const medicineId = req.query.medicine_id as string;
    const batchId = (req.query.batch_id as string) || null;
    const requestedQty = Number(req.query.quantity || 0);

    if (!medicineId) {
      return res.status(400).json({ error: 'medicine_id is required' });
    }

    const locationType = warehouseId ? 'WAREHOUSE' : 'STORE';
    const result = InventoryAvailabilityService.getAvailability({
      organizationId: orgId,
      medicineId,
      locationType,
      storeId,
      warehouseId,
      batchId,
      requestedQuantity: requestedQty,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/cross-location?medicine_id=
inventoryRouter.get('/cross-location', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const medicineId = req.query.medicine_id as string;
    if (!medicineId) {
      return res.status(400).json({ error: 'medicine_id is required' });
    }

    const result = InventoryAvailabilityService.getCrossLocationAvailability({
      organizationId: orgId,
      medicineId,
      currentStoreId: storeId,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/reconciliation
inventoryRouter.get('/reconciliation', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const medicineId = (req.query.medicine_id as string) || null;

    const result = InventoryReconciliationServiceV2.reconcile({
      organizationId: orgId,
      storeId,
      warehouseId,
      medicineId,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/reconciliation/repair
inventoryRouter.post('/reconciliation/repair', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const { medicineId, batchId, targetPhysicalQuantity, reason } = req.body;

    const locationType = warehouseId ? 'WAREHOUSE' : 'STORE';
    const result = InventoryReconciliationServiceV2.repairDiscrepancy({
      organizationId: orgId,
      medicineId,
      batchId,
      locationType,
      storeId,
      warehouseId,
      targetPhysicalQuantity: Number(targetPhysicalQuantity),
      reason: reason || 'Approved Reconciliation Adjustment',
      approvedBy: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/stocktakes
inventoryRouter.get('/stocktakes', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    let query = `SELECT * FROM stocktake_sessions WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (storeId) {
      query += ` AND (store_id = ? OR store_id IS NULL)`;
      params.push(storeId);
    }
    query += ` ORDER BY created_at DESC`;

    const sessions = localDb.prepare(query).all(...params);
    res.json({ data: sessions });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/stocktakes
inventoryRouter.post('/stocktakes', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const { name, type, scope, countingMode, isBlindCount, isDoubleCount, notes } = req.body;

    const session = StocktakeEngine.createSession({
      organizationId: orgId,
      storeId,
      warehouseId,
      name: name || `Stocktake ${new Date().toISOString().split('T')[0]}`,
      type,
      scope,
      countingMode,
      isBlindCount,
      isDoubleCount,
      initiatedBy: req.user!.id,
      notes,
    });

    res.status(201).json({ data: session });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/stocktakes/:id
inventoryRouter.get('/stocktakes/:id', requireAuth, async (req, res, next) => {
  try {
    const session = StocktakeEngine.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Stocktake session not found' });

    const isManager = (req.user?.role as string) === 'OWNER' || (req.user?.role as string) === 'STORE_MANAGER' || (req.user?.role as string) === 'SUPER_ADMIN';
    const items = StocktakeEngine.getSessionItems(req.params.id, isManager);

    res.json({ data: { session, items } });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/stocktakes/:id/start
inventoryRouter.post('/stocktakes/:id/start', requireAuth, async (req, res, next) => {
  try {
    const session = StocktakeEngine.startSession(req.params.id, req.user!.id);
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/stocktakes/:id/count
inventoryRouter.post('/stocktakes/:id/count', requireAuth, async (req, res, next) => {
  try {
    const { medicineId, batchId, counterName, scannedBarcode, rawQuantity, unitType, conversionFactor, deviceId, isOfflineSync, counterRole } = req.body;
    const result = StocktakeEngine.recordCount({
      stocktakeId: req.params.id,
      medicineId,
      batchId,
      counterName,
      userId: req.user!.id,
      scannedBarcode,
      rawQuantity: Number(rawQuantity || 1),
      unitType,
      conversionFactor: Number(conversionFactor || 1),
      deviceId,
      isOfflineSync,
      counterRole,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/stocktakes/:id/approve
inventoryRouter.post('/stocktakes/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const session = StocktakeEngine.approveSession({
      sessionId: req.params.id,
      approvedBy: req.user!.id,
      userRole: req.user?.role || 'CASHIER',
      notes: req.body.notes,
    });
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/stocktakes/:id/post
inventoryRouter.post('/stocktakes/:id/post', requireAuth, async (req, res, next) => {
  try {
    const result = StocktakeEngine.postAdjustments({
      sessionId: req.params.id,
      postedBy: req.user!.id,
      userRole: req.user?.role || 'CASHIER',
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/reorder-recommendations
inventoryRouter.get('/reorder-recommendations', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const recommendations = ReorderEngine.getReorderRecommendations({
      organizationId: orgId,
      storeId,
    });
    res.json({ data: recommendations });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/expiry-risk
inventoryRouter.get('/expiry-risk', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const days = parseInt(req.query.days as string) || 180;
    const result = ExpiryIntelligenceEngine.getExpiryRiskItems({
      organizationId: orgId,
      storeId,
      daysThreshold: days,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/ageing
inventoryRouter.get('/ageing', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const result = InventoryClassificationEngine.getAgeingAnalysis({
      organizationId: orgId,
      storeId,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/classifications
inventoryRouter.get('/classifications', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const result = InventoryClassificationEngine.computeClassifications({
      organizationId: orgId,
      storeId,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/recalls
inventoryRouter.get('/recalls', requireAuth, async (req, res, next) => {
  try {
    const { orgId } = resolveOrgAndStore(req);
    const recalls = localDb
      .prepare(
        `SELECT pr.*, m.name as product_name, m.generic_name
         FROM product_recalls pr
         JOIN medicines m ON m.id = pr.product_id
         WHERE pr.organization_id = ?
         ORDER BY pr.created_at DESC`
      )
      .all(orgId);
    res.json({ data: recalls });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/recalls
inventoryRouter.post('/recalls', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { orgId } = resolveOrgAndStore(req);
    const { recallReference, recallType, productId, batchId, batchNumber, manufacturer, reason, severity } = req.body;
    const recall = ProductRecallEngine.createRecall({
      organizationId: orgId,
      recallReference,
      recallType,
      productId,
      batchId,
      batchNumber,
      manufacturer,
      reason,
      severity,
      createdBy: req.user!.id,
    });
    res.status(201).json({ data: recall });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/recalls/:id
inventoryRouter.get('/recalls/:id', requireAuth, async (req, res, next) => {
  try {
    const recall = ProductRecallEngine.getRecall(req.params.id);
    if (!recall) return res.status(404).json({ error: 'Recall not found' });
    res.json({ data: recall });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/recalls/:id/activate
inventoryRouter.post('/recalls/:id/activate', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const recall = ProductRecallEngine.activateRecall(req.params.id, req.user!.id);
    res.json({ data: recall });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/recalls/tasks/:taskId/complete
inventoryRouter.post('/recalls/tasks/:taskId/complete', requireAuth, async (req, res, next) => {
  try {
    const { quarantinedUnits, notes } = req.body;
    const task = ProductRecallEngine.completeTask({
      taskId: req.params.taskId,
      quarantinedUnits: Number(quarantinedUnits || 0),
      completedBy: req.user!.id,
      notes,
    });
    res.json({ data: task });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/recalls/:id/trace/sales
inventoryRouter.get('/recalls/:id/trace/sales', requireAuth, async (req, res, next) => {
  try {
    const recall = ProductRecallEngine.getRecall(req.params.id);
    if (!recall) return res.status(404).json({ error: 'Recall not found' });

    const trace = ProductRecallEngine.traceHistoricalSales({
      organizationId: recall.organization_id,
      productId: recall.product_id,
      batchId: recall.batch_id,
    });
    res.json({ data: trace });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/recalls/:id/trace/prescriptions
inventoryRouter.get('/recalls/:id/trace/prescriptions', requireAuth, async (req, res, next) => {
  try {
    const recall = ProductRecallEngine.getRecall(req.params.id);
    if (!recall) return res.status(404).json({ error: 'Recall not found' });

    const trace = ProductRecallEngine.tracePrescriptionDispensing({
      organizationId: recall.organization_id,
      productId: recall.product_id,
      batchId: recall.batch_id,
    });
    res.json({ data: trace });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/reservations
inventoryRouter.post('/reservations', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const { medicineId, batchId, quantity, sourceType, sourceId, durationMinutes } = req.body;

    const locationType = warehouseId ? 'WAREHOUSE' : 'STORE';
    const reservation = InventoryReservationService.createReservation({
      organizationId: orgId,
      locationType,
      storeId,
      warehouseId,
      medicineId,
      batchId,
      quantity: Number(quantity),
      sourceType: sourceType || 'MANUAL',
      sourceId: sourceId || 'MANUAL-RES',
      durationMinutes: Number(durationMinutes || 60),
      createdBy: req.user!.id,
    });

    res.status(201).json({ data: reservation });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/inventory/reservations/:id
inventoryRouter.delete('/reservations/:id', requireAuth, async (req, res, next) => {
  try {
    InventoryReservationService.releaseReservation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/alerts
inventoryRouter.get('/alerts', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId } = resolveOrgAndStore(req);
    const alerts = InventoryAlertEngine.listAlerts({
      organizationId: orgId,
      storeId,
    });
    res.json({ data: alerts });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/inventory/alerts/:id
inventoryRouter.patch('/alerts/:id', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const alert = InventoryAlertEngine.updateAlertStatus({
      alertId: req.params.id,
      status: status || 'ACKNOWLEDGED',
      acknowledgedBy: req.user!.id,
    });
    res.json({ data: alert });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/valuation
inventoryRouter.get('/valuation', requireAuth, async (req, res, next) => {
  try {
    const { orgId, storeId, warehouseId } = resolveOrgAndStore(req);
    const valuation = InventoryValuationService.getValuation({
      organizationId: orgId,
      storeId,
      warehouseId,
    });
    res.json({ data: valuation });
  } catch (err) {
    next(err);
  }
});

export default inventoryRouter;
