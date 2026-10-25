import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { BARCODE_TYPES, PRODUCT_UNITS } from '../domain/units';

export const barcodesRouter = Router();

// GET /api/barcodes/lookup?code=
barcodesRouter.get('/lookup', requireAuth, async (req, res, next) => {
  try {
    const code = (req.query.code as string)?.trim();
    if (!code) {
      return res.status(400).json({ error: 'code query param is required' });
    }

    const clinicId = req.user!.clinic_id;
    let orgId = 'default-org';
    if (clinicId) {
      const clinic: any = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(clinicId, clinicId);
      if (clinic?.organization_id) orgId = clinic.organization_id;
    }

    // Check alternate barcodes first
    const barcodeRow: any = localDb
      .prepare('SELECT * FROM product_barcodes WHERE barcode = ? AND (organization_id = ? OR organization_id = "default-org") AND _deleted = 0')
      .get(code, orgId);

    if (barcodeRow) {
      const medicine: any = localDb
        .prepare('SELECT * FROM medicines WHERE id = ? OR _local_id = ?')
        .get(barcodeRow.medicine_id, barcodeRow.medicine_id);

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
      .prepare('SELECT * FROM medicines WHERE (barcode = ? OR primary_barcode = ?) AND _deleted = 0')
      .get(code, code);

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
    const medId = req.params.medicineId;
    const barcodes = localDb
      .prepare('SELECT * FROM product_barcodes WHERE (medicine_id = ? OR medicine_id IN (SELECT id FROM medicines WHERE _local_id = ?)) AND _deleted = 0')
      .all(medId, medId);
    res.json({ data: barcodes });
  } catch (err) {
    next(err);
  }
});

// POST /api/barcodes
barcodesRouter.post('/', requireAuth, requireRole('PHARMACIST', 'OWNER'), async (req, res, next) => {
  try {
    const {
      medicine_id,
      barcode,
      barcode_type = 'MANUFACTURER',
      unit_type = 'STRIP',
      conversion_factor = 1.0,
      is_primary = false,
    } = req.body;

    if (!medicine_id || !barcode) {
      return res.status(400).json({ error: 'medicine_id and barcode are required' });
    }

    const clinicId = req.user!.clinic_id;
    let organizationId = 'default-org';
    if (clinicId) {
      const clinic: any = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(clinicId, clinicId);
      if (clinic?.organization_id) organizationId = clinic.organization_id;
    }

    // Check duplicate within organization
    const existing: any = localDb
      .prepare('SELECT * FROM product_barcodes WHERE organization_id = ? AND barcode = ? AND _deleted = 0')
      .get(organizationId, barcode);

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
        organizationId,
        medicine_id,
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
