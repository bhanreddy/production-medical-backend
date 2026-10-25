import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import {
  Prescription,
  PrescriptionItem,
  PrescriptionStatus,
  VerificationStatus,
  RejectionReason,
  PrescriptionSource,
} from '../../domain/prescriptionTypes';
import { DoctorService } from './doctorService';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../../lib/appError';

export class PrescriptionService {
  static createPrescription(params: {
    organizationId: string;
    storeId?: string | null;
    patientId?: string | null;
    prescriptionNumber?: string;
    externalRxNumber?: string | null;
    doctorId?: string | null;
    doctorName: string;
    doctorRegistrationNumber: string;
    prescribedAt?: string;
    validFrom?: string;
    validUntil?: string | null;
    documentUrl: string;
    documentHash?: string | null;
    source?: PrescriptionSource;
    notes?: string | null;
    createdBy?: string | null;
    items?: Array<{
      sequence?: number;
      raw_text: string;
      prescribed_name: string;
      matched_product_id?: string | null;
      generic_name?: string | null;
      strength?: string | null;
      dosage_form?: string | null;
      dose_text?: string | null;
      frequency_text?: string | null;
      duration_text?: string | null;
      prescribed_quantity?: number;
      repeats_authorized?: number;
      repeat_interval_days?: number | null;
      substitution_allowed?: boolean;
      notes?: string | null;
    }>;
  }): { prescription: Prescription; isDuplicateHashWarning: boolean } {
    const {
      organizationId,
      storeId = null,
      patientId = null,
      externalRxNumber = null,
      doctorId = null,
      doctorName,
      doctorRegistrationNumber,
      prescribedAt = new Date().toISOString(),
      validFrom = new Date().toISOString(),
      validUntil = null,
      documentUrl,
      documentHash = null,
      source = 'FILE_UPLOAD',
      notes = null,
      createdBy = null,
      items = [],
    } = params;

    // Check for duplicate document hash
    let isDuplicateHashWarning = false;
    if (documentHash) {
      const existingHash: any = localDb
        .prepare('SELECT id FROM prescriptions WHERE organization_id = ? AND document_hash = ? AND _deleted = 0')
        .get(organizationId, documentHash);
      if (existingHash) {
        isDuplicateHashWarning = true;
      }
    }

    // Auto-resolve or register Doctor Master record while preserving snapshots
    let resolvedDoctorId: string | null = doctorId || null;
    if (!resolvedDoctorId && doctorRegistrationNumber) {
      const doc = DoctorService.findOrCreateByRegistration({
        organizationId,
        name: doctorName,
        registrationNumber: doctorRegistrationNumber,
      });
      resolvedDoctorId = doc.id || doc._local_id || null;
    }

    const prescriptionId = uuidv4();
    const rxNumber = params.prescriptionNumber || `RX-${Date.now().toString().slice(-8)}`;

    const rxRecord = localMutate({
      table: 'prescriptions',
      operation: 'INSERT',
      data: {
        id: prescriptionId,
        _local_id: prescriptionId,
        organization_id: organizationId,
        store_id: storeId,
        patient_id: patientId,
        prescription_number: rxNumber,
        external_rx_number: externalRxNumber,
        doctor_id: resolvedDoctorId || null,
        doctor_name_snapshot: doctorName.trim(),
        doctor_registration_number_snapshot: doctorRegistrationNumber.trim().toUpperCase(),
        prescribed_at: prescribedAt,
        valid_from: validFrom,
        valid_until: validUntil,
        document_url: documentUrl,
        document_hash: documentHash,
        source,
        status: 'NEEDS_REVIEW',
        verification_status: 'UNVERIFIED',
        notes,
        created_by: createdBy,
        created_at: new Date().toISOString(),
      },
    }) as Prescription;

    // Insert Prescription Items
    const insertedItems: PrescriptionItem[] = [];
    items.forEach((item, index) => {
      const itemId = uuidv4();
      const seq = item.sequence || index + 1;
      const matchStatus = item.matched_product_id ? 'AUTO_MATCHED' : 'UNMATCHED';

      const itemRecord = localMutate({
        table: 'prescription_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          prescription_id: prescriptionId,
          sequence: seq,
          raw_text: item.raw_text,
          matched_product_id: item.matched_product_id || null,
          generic_name: item.generic_name || null,
          prescribed_name: item.prescribed_name,
          strength: item.strength || null,
          dosage_form: item.dosage_form || null,
          dose_text: item.dose_text || null,
          frequency_text: item.frequency_text || null,
          duration_text: item.duration_text || null,
          prescribed_quantity: item.prescribed_quantity || 1,
          dispensed_quantity: 0,
          repeats_authorized: item.repeats_authorized || 0,
          repeats_used: 0,
          repeat_interval_days: item.repeat_interval_days || null,
          substitution_allowed: item.substitution_allowed !== false ? 1 : 0,
          notes: item.notes || null,
          match_status: matchStatus,
          created_at: new Date().toISOString(),
        },
      }) as PrescriptionItem;

      insertedItems.push(itemRecord);
    });

    rxRecord.items = insertedItems;

    return {
      prescription: rxRecord,
      isDuplicateHashWarning,
    };
  }

  static getPrescriptionById(id: string): Prescription | null {
    const rx: any = localDb
      .prepare('SELECT * FROM prescriptions WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
      .get(id, id);

    if (!rx) return null;

    const items: any[] = localDb
      .prepare('SELECT * FROM prescription_items WHERE prescription_id = ? AND _deleted = 0 ORDER BY sequence ASC')
      .all(rx.id || rx._local_id);

    rx.items = items;
    return rx as Prescription;
  }

  static getQueue(params: {
    organizationId: string;
    storeId?: string;
    status?: PrescriptionStatus;
    assignedTo?: string;
    patientId?: string;
    page?: number;
    limit?: number;
  }): { prescriptions: Prescription[]; total: number; page: number; totalPages: number } {
    const { organizationId, storeId, status, assignedTo, patientId, page = 1, limit = 20 } = params;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE organization_id = ? AND _deleted = 0';
    const sqlParams: any[] = [organizationId];

    if (storeId) {
      whereClause += ' AND (store_id = ? OR store_id IS NULL)';
      sqlParams.push(storeId);
    }

    if (status) {
      whereClause += ' AND status = ?';
      sqlParams.push(status);
    }

    if (assignedTo) {
      whereClause += ' AND assigned_to = ?';
      sqlParams.push(assignedTo);
    }

    if (patientId) {
      whereClause += ' AND patient_id = ?';
      sqlParams.push(patientId);
    }

    const countRow: any = localDb
      .prepare(`SELECT COUNT(*) as count FROM prescriptions ${whereClause}`)
      .get(...sqlParams);

    const total = Number(countRow?.count || 0);
    const totalPages = Math.ceil(total / limit) || 1;

    const query = `SELECT * FROM prescriptions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows: any[] = localDb.prepare(query).all(...sqlParams, limit, offset);

    rows.forEach((rx) => {
      const items: any[] = localDb
        .prepare('SELECT * FROM prescription_items WHERE prescription_id = ? AND _deleted = 0 ORDER BY sequence ASC')
        .all(rx.id || rx._local_id);
      rx.items = items;
    });

    return {
      prescriptions: rows as Prescription[],
      total,
      page,
      totalPages,
    };
  }

  static claimPrescription(params: { prescriptionId: string; pharmacistId: string }): Prescription {
    const rx = this.getPrescriptionById(params.prescriptionId);
    if (!rx) {
      throw new Error('Prescription not found');
    }

    const pId = rx.id || rx._local_id!;
    localMutate({
      table: 'prescriptions',
      operation: 'UPDATE',
      data: {
        id: pId,
        _local_id: pId,
        assigned_to: params.pharmacistId,
        assigned_at: new Date().toISOString(),
        verification_status: 'IN_REVIEW',
      },
    });

    return this.getPrescriptionById(pId)!;
  }

  static verifyPrescription(params: {
    prescriptionId: string;
    verifiedBy: string;
    itemUpdates?: Array<{
      itemId: string;
      matchedProductId?: string | null;
      prescribedQuantity?: number;
      substitutionAllowed?: boolean;
    }>;
    notes?: string;
  }): Prescription {
    const rx = this.getPrescriptionById(params.prescriptionId);
    if (!rx) {
      throw new Error('Prescription not found');
    }

    const pId = rx.id || rx._local_id!;

    for (const upd of params.itemUpdates || []) {
      const item = localDb.prepare('SELECT prescription_id FROM prescription_items WHERE (id = ? OR _local_id = ?) AND _deleted = 0').get(upd.itemId, upd.itemId) as { prescription_id: string } | undefined;
      if (!item || item.prescription_id !== pId) throw new AppError(400, 'Item does not belong to this prescription');
      if (upd.prescribedQuantity !== undefined && (!Number.isInteger(upd.prescribedQuantity) || upd.prescribedQuantity <= 0)) throw new AppError(400, 'Prescribed quantity must be a positive integer');
    }

    // Perform item updates if provided
    if (params.itemUpdates && params.itemUpdates.length > 0) {
      params.itemUpdates.forEach((upd) => {
        const itemRow: any = localDb
          .prepare('SELECT * FROM prescription_items WHERE id = ? OR _local_id = ?')
          .get(upd.itemId, upd.itemId);

        if (itemRow) {
          const iId = itemRow.id || itemRow._local_id;
          localMutate({
            table: 'prescription_items',
            operation: 'UPDATE',
            data: {
              id: iId,
              _local_id: iId,
              matched_product_id: upd.matchedProductId !== undefined ? upd.matchedProductId : itemRow.matched_product_id,
              prescribed_quantity: upd.prescribedQuantity !== undefined ? upd.prescribedQuantity : itemRow.prescribed_quantity,
              substitution_allowed: upd.substitutionAllowed !== undefined ? (upd.substitutionAllowed ? 1 : 0) : itemRow.substitution_allowed,
              match_status: upd.matchedProductId ? 'VERIFIED' : itemRow.match_status,
            },
          });
        }
      });
    }

    const verifiedAt = new Date().toISOString();
    localMutate({
      table: 'prescriptions',
      operation: 'UPDATE',
      data: {
        id: pId,
        _local_id: pId,
        status: 'VERIFIED',
        verification_status: 'VERIFIED',
        verified_by: params.verifiedBy,
        verified_at: verifiedAt,
        notes: params.notes || rx.notes,
      },
    });

    return this.getPrescriptionById(pId)!;
  }

  static rejectPrescription(params: {
    prescriptionId: string;
    rejectedBy: string;
    rejectionReason: RejectionReason | string;
    notes?: string;
  }): Prescription {
    const rx = this.getPrescriptionById(params.prescriptionId);
    if (!rx) {
      throw new Error('Prescription not found');
    }

    const pId = rx.id || rx._local_id!;
    localMutate({
      table: 'prescriptions',
      operation: 'UPDATE',
      data: {
        id: pId,
        _local_id: pId,
        status: 'REJECTED',
        verification_status: 'REJECTED',
        verified_by: params.rejectedBy,
        verified_at: new Date().toISOString(),
        rejection_reason: params.rejectionReason,
        notes: params.notes || rx.notes,
      },
    });

    return this.getPrescriptionById(pId)!;
  }
}
