import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/appError';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { BARCODE_TYPES, PRODUCT_UNITS } from '../domain/units';

export const barcodesRouter = Router();

function organizationId(req: Request): string {
  const clinic = localDb.prepare('SELECT organization_id FROM clinics WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
    .get(req.user!.clinic_id, req.user!.clinic_id) as { organization_id?: string } | undefined;
  const id = clinic?.organization_id || req.user?.organization_id;
  if (!id) throw new AppError(403, 'Choose a pharmacy before managing barcodes');
  return id;
}
function findMedicine(id: string, orgId: string) {
  return localDb.prepare('SELECT * FROM medicines WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0 AND is_active = 1')
    .get(id, id, orgId) as { id: string } | undefined;
}
const barcodeSchema = z.object({
  medicine_id: z.string().min(1), barcode: z.string().trim().min(1).max(128),
  barcode_type: z.enum(BARCODE_TYPES).default('MANUFACTURER'),
  unit_type: z.enum(PRODUCT_UNITS).default('STRIP'),
  conversion_factor: z.number().finite().positive().default(1),
  is_primary: z.boolean().default(false),
});

// GET /api/barcodes/lookup?code=
barcodesRouter.get('/lookup', requireAuth, async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    if (!code) {
      return res.status(400).json({ error: 'code query param is required' });
    }

    const orgId = organizationId(req);

    // Check alternate barcodes first
    const barcodeRow: any = localDb
      .prepare('SELECT * FROM product_barcodes WHERE barcode = ? AND organization_id = ? AND _deleted = 0')
      .get(code, orgId);

    if (barcodeRow) {
      const medicine = findMedicine(barcodeRow.medicine_id, orgId);
      if (!medicine) throw new AppError(404, 'Product not found for barcode');

      return res.json({
        data: {
          barcode: barcodeRow,
          medicine,
          matched_via: 'alternate_barcode',
        },
      });
    }

    // Fallback: Check primary barcode on medicines table
    const medicineRow: any = localDb
      .prepare('SELECT * FROM medicines WHERE primary_barcode = ? AND organization_id = ? AND _deleted = 0 AND is_active = 1')
      .get(code, orgId);

    if (medicineRow) {
      return res.json({
        data: {
          barcode: {
            barcode: code,
            barcode_type: 'MANUFACTURER',
            unit_type: medicineRow.unit || 'UNIT',
            conversion_factor: 1.0,
            is_primary: 1,
          },
          medicine: medicineRow,
          matched_via: 'primary_barcode',
        },
      });
    }

    res.status(404).json({ error: 'Product not found for barcode' });
  } catch (err) {
    next(err);
  }
});

// GET /api/barcodes/medicine/:medicineId
barcodesRouter.get('/medicine/:medicineId', requireAuth, async (req, res, next) => {
  try {
    const orgId = organizationId(req);
    const medicine = findMedicine(req.params.medicineId, orgId);
    if (!medicine) throw new AppError(404, 'Medicine not found');
    const medId = medicine.id;
    const barcodes = localDb
      .prepare('SELECT * FROM product_barcodes WHERE medicine_id = ? AND organization_id = ? AND _deleted = 0')
      .all(medId, orgId);
    res.json({ data: barcodes });
  } catch (err) {
    next(err);
  }
});

// POST /api/barcodes
barcodesRouter.post('/', requireAuth, requireRole('PHARMACIST', 'OWNER'), async (req, res, next) => {
  try {
    const { medicine_id, barcode, barcode_type, unit_type, conversion_factor, is_primary } = barcodeSchema.parse(req.body);
    const orgId = organizationId(req);
    const medicine = findMedicine(medicine_id, orgId);
    if (!medicine) throw new AppError(404, 'Medicine not found');

    // Check duplicate within organization
    const existing: any = localDb
      .prepare('SELECT * FROM product_barcodes WHERE organization_id = ? AND barcode = ? AND _deleted = 0')
      .get(orgId, barcode);

    if (existing) {
      return res.status(409).json({ error: `Barcode ${barcode} already registered in organization` });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO product_barcodes (
           id, _local_id, organization_id, medicine_id, barcode, barcode_type,
           unit_type, conversion_factor, is_primary, created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        orgId,
        medicine.id,
        barcode,
        barcode_type,
        unit_type,
        conversion_factor,
        is_primary ? 1 : 0,
        now,
        now,
        now
      );

    const created = localDb.prepare('SELECT * FROM product_barcodes WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

export default barcodesRouter;
