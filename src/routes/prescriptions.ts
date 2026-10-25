import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { PrescriptionService } from '../services/prescription/prescriptionService';
import { PrescriptionStorageService } from '../services/prescription/prescriptionStorageService';
import { PrescriptionExtractionService } from '../services/prescription/prescriptionExtractionService';
import { DispensingEngine } from '../services/prescription/dispensingEngine';
import { AppError } from '../lib/appError';
import multer from 'multer';
import { z } from 'zod';
import { localDb } from '../local-db';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 25 } });
export const prescriptionsRouter = Router();

prescriptionsRouter.use(requireAuth);
function organizationId(req: any): string {
  if (!req.user?.clinic_id) throw new AppError(403, 'No clinic assigned');
  const clinic = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(req.user.clinic_id, req.user.clinic_id) as { organization_id?: string } | undefined;
  return clinic?.organization_id || req.user.clinic_id;
}
function ownedPrescription(req: any) {
  const rx = PrescriptionService.getPrescriptionById(req.params.id);
  if (!rx || ![organizationId(req), req.user.clinic_id].includes(rx.organization_id)) throw new AppError(404, 'Prescription not found', 'RX_NOT_FOUND');
  return rx;
}
const writeRole = requireRole('OWNER', 'PHARMACIST', 'SUPER_ADMIN');
const itemSchema = z.object({
  raw_text: z.string().trim().min(1).max(2000), prescribed_name: z.string().trim().min(1).max(2000),
  prescribed_quantity: z.number().int().positive().max(10000),
  substitution_allowed: z.boolean().optional(), matched_product_id: z.string().uuid().nullable().optional(),
});

// Document Proxy URL
prescriptionsRouter.get('/document/signed-proxy', async (req, res, next) => {
  try {
    const key = req.query.key as string;
    if (!key) {
      throw new AppError(400, 'Document key required', 'MISSING_KEY');
    }
    const document = localDb.prepare('SELECT organization_id FROM prescriptions WHERE document_url = ? AND _deleted = 0').get(key) as { organization_id: string } | undefined;
    if (!document || ![organizationId(req), req.user!.clinic_id].includes(document.organization_id)) throw new AppError(404, 'Prescription document not found');
    const filePath = PrescriptionStorageService.resolveFile(key);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath, err => { if (err) next(new AppError(404, 'Prescription document is unavailable')); });
  } catch (err) {
    next(err);
  }
});

// Upload & Create Prescription
prescriptionsRouter.post('/', writeRole, upload.single('file'), async (req, res, next) => {
  try {
    const orgId = organizationId(req);
    const {
      store_id,
      patient_id,
      prescription_number,
      external_rx_number,
      doctor_id,
      doctor_name,
      doctor_registration_number,
      prescribed_at,
      valid_from,
      valid_until,
      notes,
      items_json,
    } = req.body;

    z.string().trim().min(1).max(200).parse(doctor_name);
    z.string().trim().min(1).max(100).parse(doctor_registration_number);
    if (patient_id) {
      const patient = localDb.prepare('SELECT id FROM customers WHERE (id = ? OR _local_id = ?) AND (organization_id = ? OR clinic_id = ?) AND _deleted = 0').get(patient_id, patient_id, orgId, req.user!.clinic_id);
      if (!patient) throw new AppError(400, 'Patient does not belong to your clinic');
    }
    if (doctor_id) {
      const doctor = localDb.prepare('SELECT id FROM doctors WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0').get(doctor_id, doctor_id, orgId);
      if (!doctor) throw new AppError(400, 'Doctor does not belong to your organization');
    }
    if (store_id) {
      const store = localDb.prepare('SELECT id FROM stores WHERE id = ? AND organization_id = ? AND _deleted = 0').get(store_id, orgId);
      if (!store) throw new AppError(400, 'Store does not belong to your organization');
    }
    let finalDocUrl = '';
    let docHash: string | null = null;

    // Handle file upload if present
    if (req.file) {
      const storageResult = PrescriptionStorageService.validateAndGenerateKey({
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileBuffer: req.file.buffer,
        organizationId: orgId,
      });

      if (!storageResult.isValid) {
        throw new AppError(400, storageResult.errorMessage || 'Invalid prescription file upload', 'INVALID_FILE_UPLOAD');
      }

      finalDocUrl = storageResult.storageKey!;
      docHash = storageResult.documentHash || null;
    }

    let rawItems: unknown = items_json || [];
    if (typeof rawItems === 'string') {
      try { rawItems = JSON.parse(rawItems); } catch { throw new AppError(400, 'Invalid prescription items'); }
    }
    const parsedItems = z.array(itemSchema).max(100).parse(rawItems);
    for (const item of parsedItems) {
      if (item.matched_product_id && !localDb.prepare('SELECT id FROM medicines WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0').get(item.matched_product_id, item.matched_product_id, orgId)) throw new AppError(400, 'Medicine does not belong to your organization');
    }
    if (!req.file && !parsedItems.length) throw new AppError(400, 'Attach a document or enter prescription items');
    if (req.file) await PrescriptionStorageService.save(finalDocUrl, req.file.buffer);

    let result;
    try {
      result = localDb.transaction(() => PrescriptionService.createPrescription({
      organizationId: orgId,
      storeId: store_id || null,
      patientId: patient_id || null,
      prescriptionNumber: prescription_number,
      externalRxNumber: external_rx_number || null,
      doctorId: doctor_id || null,
      doctorName: doctor_name,
      doctorRegistrationNumber: doctor_registration_number,
      prescribedAt: prescribed_at,
      validFrom: valid_from,
      validUntil: valid_until || null,
      documentUrl: finalDocUrl,
      documentHash: docHash,
      source: req.file ? 'FILE_UPLOAD' : 'MANUAL_ENTRY',
      notes: notes || null,
      createdBy: req.user?.id,
      items: parsedItems,
      }))();
    } catch (error) {
      if (req.file) await PrescriptionStorageService.remove(finalDocUrl);
      throw error;
    }
    const { prescription, isDuplicateHashWarning } = result;

    res.status(201).json({
      success: true,
      data: prescription,
      warning: isDuplicateHashWarning ? 'This prescription appears to have been uploaded previously.' : null,
    });
  } catch (err) {
    next(err);
  }
});

// Verification Queue
prescriptionsRouter.get('/', async (req, res, next) => {
  try {
    const orgId = organizationId(req);
    const { store_id, status, assigned_to, patient_id, page, limit } = req.query;

    const result = PrescriptionService.getQueue({
      organizationId: orgId,
      storeId: store_id as string,
      status: status as any,
      assignedTo: assigned_to as string,
      patientId: patient_id as string,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 20,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Get Details
prescriptionsRouter.get('/:id', async (req, res, next) => {
  try {
    const rx = ownedPrescription(req);
    if (!rx) {
      throw new AppError(404, 'Prescription not found', 'RX_NOT_FOUND');
    }
    res.json({ success: true, data: rx });
  } catch (err) {
    next(err);
  }
});

// Claim prescription
prescriptionsRouter.post('/:id/claim', writeRole, async (req, res, next) => {
  try {
    ownedPrescription(req);
    const rx = PrescriptionService.claimPrescription({
      prescriptionId: req.params.id,
      pharmacistId: req.user!.id,
    });
    res.json({ success: true, data: rx });
  } catch (err) {
    next(err);
  }
});

// Verify prescription
prescriptionsRouter.post('/:id/verify', writeRole, async (req, res, next) => {
  try {
    ownedPrescription(req);
    const { item_updates, notes } = z.object({
      item_updates: z.array(z.object({ itemId: z.string().uuid(), matchedProductId: z.string().uuid().nullable().optional(), prescribedQuantity: z.number().int().positive().max(10000).optional(), substitutionAllowed: z.boolean().optional() })).max(100).default([]),
      notes: z.string().max(5000).optional(),
    }).parse(req.body);
    for (const item of item_updates) {
      if (item.matchedProductId && !localDb.prepare('SELECT id FROM medicines WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0').get(item.matchedProductId, item.matchedProductId, organizationId(req))) throw new AppError(400, 'Medicine does not belong to your organization');
    }
    const rx = PrescriptionService.verifyPrescription({
      prescriptionId: req.params.id,
      verifiedBy: req.user!.id,
      itemUpdates: item_updates || [],
      notes,
    });
    res.json({ success: true, data: rx });
  } catch (err) {
    next(err);
  }
});

// Reject prescription
prescriptionsRouter.post('/:id/reject', writeRole, async (req, res, next) => {
  try {
    ownedPrescription(req);
    const { rejection_reason, notes } = z.object({ rejection_reason: z.enum(['UNREADABLE', 'EXPIRED', 'INVALID', 'MISSING_DOCTOR_DETAILS', 'MEDICINE_UNCLEAR', 'DUPLICATE_SUSPECTED', 'OTHER']), notes: z.string().max(5000).optional() }).parse(req.body);
    if (!rejection_reason) {
      throw new AppError(400, 'Rejection reason is required', 'MISSING_REASON');
    }

    const rx = PrescriptionService.rejectPrescription({
      prescriptionId: req.params.id,
      rejectedBy: req.user!.id,
      rejectionReason: rejection_reason,
      notes,
    });
    res.json({ success: true, data: rx });
  } catch (err) {
    next(err);
  }
});

// OCR Extraction Service Boundary
prescriptionsRouter.post('/:id/extract', async (req, res, next) => {
  try {
    const rx = ownedPrescription(req);
    if (!rx) {
      throw new AppError(404, 'Prescription not found', 'RX_NOT_FOUND');
    }

    const extraction = PrescriptionExtractionService.extractCandidates({
      rawDocumentText: rx.items?.map(item => item.raw_text).join('\n') || '',
    });

    res.json({ success: true, data: extraction });
  } catch (err) {
    next(err);
  }
});

// Dispensing History
prescriptionsRouter.get('/:id/dispensing', async (req, res, next) => {
  try {
    ownedPrescription(req);
    const history = DispensingEngine.getDispensingHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});
