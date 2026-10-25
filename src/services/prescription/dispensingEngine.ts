import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { DispensingEvent, RefillEligibility } from '../../domain/prescriptionTypes';
import { PrescriptionService } from './prescriptionService';
import { v4 as uuidv4 } from 'uuid';

export interface DispensingValidationResult {
  allowed: boolean;
  prescribedQuantity: number;
  alreadyDispensedQuantity: number;
  remainingAllowedQuantity: number;
  requestedQuantity: number;
  errorMessage?: string;
}

export class DispensingEngine {
  static validateDispensing(params: {
    prescriptionId: string;
    prescriptionItemId: string;
    requestedQuantity: number;
  }): DispensingValidationResult {
    const { prescriptionId, prescriptionItemId, requestedQuantity } = params;

    const rx = PrescriptionService.getPrescriptionById(prescriptionId);
    if (!rx) {
      return {
        allowed: false,
        prescribedQuantity: 0,
        alreadyDispensedQuantity: 0,
        remainingAllowedQuantity: 0,
        requestedQuantity,
        errorMessage: 'Prescription not found',
      };
    }

    if (rx.status === 'REJECTED' || rx.status === 'CANCELLED' || rx.status === 'EXPIRED') {
      return {
        allowed: false,
        prescribedQuantity: 0,
        alreadyDispensedQuantity: 0,
        remainingAllowedQuantity: 0,
        requestedQuantity,
        errorMessage: `Prescription status '${rx.status}' does not allow dispensing`,
      };
    }

    if (rx.verification_status !== 'VERIFIED') {
      return {
        allowed: false,
        prescribedQuantity: 0,
        alreadyDispensedQuantity: 0,
        remainingAllowedQuantity: 0,
        requestedQuantity,
        errorMessage: 'Prescription must be verified by a pharmacist before dispensing',
      };
    }

    const itemRow: any = localDb
      .prepare('SELECT * FROM prescription_items WHERE (id = ? OR _local_id = ?) AND prescription_id = ? AND _deleted = 0')
      .get(prescriptionItemId, prescriptionItemId, rx.id || rx._local_id);

    if (!itemRow) {
      return {
        allowed: false,
        prescribedQuantity: 0,
        alreadyDispensedQuantity: 0,
        remainingAllowedQuantity: 0,
        requestedQuantity,
        errorMessage: 'Prescription item line not found',
      };
    }

    const prescribedQuantity = Number(itemRow.prescribed_quantity || 0);
    const alreadyDispensedQuantity = Number(itemRow.dispensed_quantity || 0);
    const repeatsAuthorized = Number(itemRow.repeats_authorized || 0);

    // Total authorized quantity across all repeats
    const totalAllowedQuantity = prescribedQuantity * (1 + repeatsAuthorized);
    const remainingAllowedQuantity = Math.max(0, totalAllowedQuantity - alreadyDispensedQuantity);

    if (requestedQuantity <= 0) {
      return {
        allowed: false,
        prescribedQuantity,
        alreadyDispensedQuantity,
        remainingAllowedQuantity,
        requestedQuantity,
        errorMessage: 'Requested quantity must be greater than zero',
      };
    }

    if (alreadyDispensedQuantity + requestedQuantity > totalAllowedQuantity) {
      return {
        allowed: false,
        prescribedQuantity,
        alreadyDispensedQuantity,
        remainingAllowedQuantity,
        requestedQuantity,
        errorMessage: `Dispensing limit exceeded. Requested: ${requestedQuantity}, Already Dispensed: ${alreadyDispensedQuantity}, Total Allowed: ${totalAllowedQuantity}`,
      };
    }

    return {
      allowed: true,
      prescribedQuantity,
      alreadyDispensedQuantity,
      remainingAllowedQuantity,
      requestedQuantity,
    };
  }

  static recordDispensing(params: {
    organizationId: string;
    storeId: string;
    terminalId?: string | null;
    prescriptionId: string;
    prescriptionItemId: string;
    saleId?: string | null;
    saleItemId?: string | null;
    productId: string;
    batchId: string;
    quantityDispensed: number;
    baseUnitQuantity?: number;
    dispensedBy: string;
  }): DispensingEvent {
    const {
      organizationId,
      storeId,
      terminalId = null,
      prescriptionId,
      prescriptionItemId,
      saleId = null,
      saleItemId = null,
      productId,
      batchId,
      quantityDispensed,
      baseUnitQuantity = 1,
      dispensedBy,
    } = params;

    // Strict validation check
    const validation = this.validateDispensing({
      prescriptionId,
      prescriptionItemId,
      requestedQuantity: quantityDispensed,
    });

    if (!validation.allowed) {
      throw new Error(validation.errorMessage || 'Invalid dispensing request');
    }

    const itemRow: any = localDb
      .prepare('SELECT * FROM prescription_items WHERE id = ? OR _local_id = ?')
      .get(prescriptionItemId, prescriptionItemId);

    const iId = itemRow.id || itemRow._local_id;
    const newDispensedQty = Number(itemRow.dispensed_quantity || 0) + quantityDispensed;
    const prescribedQty = Number(itemRow.prescribed_quantity || 1);
    const repeatsAuth = Number(itemRow.repeats_authorized || 0);
    const newRepeatsUsed = Math.min(repeatsAuth, Math.floor(newDispensedQty / prescribedQty));

    // Update prescription_items.dispensed_quantity and repeats_used
    localMutate({
      table: 'prescription_items',
      operation: 'UPDATE',
      data: {
        id: iId,
        _local_id: iId,
        dispensed_quantity: newDispensedQty,
        repeats_used: newRepeatsUsed,
      },
    });

    // Create dispensing_event
    const eventId = uuidv4();
    const eventRecord = localMutate({
      table: 'dispensing_events',
      operation: 'INSERT',
      data: {
        id: eventId,
        _local_id: eventId,
        organization_id: organizationId,
        store_id: storeId,
        terminal_id: terminalId,
        prescription_id: prescriptionId,
        prescription_item_id: iId,
        sale_id: saleId,
        sale_item_id: saleItemId,
        product_id: productId,
        batch_id: batchId,
        quantity_dispensed: quantityDispensed,
        base_unit_quantity: baseUnitQuantity,
        dispensed_by: dispensedBy,
        dispensed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    }) as DispensingEvent;

    // Check if ALL items in prescription are fully dispensed
    const rx = PrescriptionService.getPrescriptionById(prescriptionId)!;
    const pId = rx.id || rx._local_id!;
    let allFullyDispensed = true;

    rx.items?.forEach((it) => {
      const itQty = it.id === iId ? newDispensedQty : it.dispensed_quantity;
      const itAllowed = it.prescribed_quantity * (1 + it.repeats_authorized);
      if (itQty < itAllowed) {
        allFullyDispensed = false;
      }
    });

    const newRxStatus = allFullyDispensed ? 'DISPENSED' : 'PARTIALLY_DISPENSED';
    localMutate({
      table: 'prescriptions',
      operation: 'UPDATE',
      data: {
        id: pId,
        _local_id: pId,
        status: newRxStatus,
      },
    });

    return eventRecord;
  }

  static getRefillEligibility(prescriptionId: string, prescriptionItemId: string): {
    status: RefillEligibility;
    repeatsAuthorized: number;
    repeatsUsed: number;
    remainingRepeats: number;
    validUntil?: string | null;
  } {
    const rx = PrescriptionService.getPrescriptionById(prescriptionId);
    if (!rx) {
      return { status: 'NOT_ELIGIBLE', repeatsAuthorized: 0, repeatsUsed: 0, remainingRepeats: 0 };
    }

    if (rx.status === 'EXPIRED') {
      return { status: 'EXPIRED', repeatsAuthorized: 0, repeatsUsed: 0, remainingRepeats: 0 };
    }

    const itemRow: any = localDb
      .prepare('SELECT * FROM prescription_items WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
      .get(prescriptionItemId, prescriptionItemId);

    if (!itemRow) {
      return { status: 'NOT_ELIGIBLE', repeatsAuthorized: 0, repeatsUsed: 0, remainingRepeats: 0 };
    }

    const prescribedQty = Number(itemRow.prescribed_quantity || 1);
    const repeatsAuth = Number(itemRow.repeats_authorized || 0);
    const repeatsUsed = Number(itemRow.repeats_used || 0);
    const dispensedQty = Number(itemRow.dispensed_quantity || 0);
    const totalAllowed = prescribedQty * (1 + repeatsAuth);
    const remainingRepeats = Math.max(0, repeatsAuth - repeatsUsed);

    if (dispensedQty >= totalAllowed || (repeatsAuth > 0 && remainingRepeats === 0)) {
      return {
        status: 'EXHAUSTED',
        repeatsAuthorized: repeatsAuth,
        repeatsUsed: Math.max(repeatsUsed, repeatsAuth),
        remainingRepeats: 0,
        validUntil: itemRow.repeats_valid_until,
      };
    }

    return {
      status: 'ELIGIBLE_NOW',
      repeatsAuthorized: repeatsAuth,
      repeatsUsed,
      remainingRepeats,
      validUntil: itemRow.repeats_valid_until,
    };
  }

  static getDispensingHistory(prescriptionId: string): DispensingEvent[] {
    const rows: any[] = localDb
      .prepare('SELECT * FROM dispensing_events WHERE prescription_id = ? AND _deleted = 0 ORDER BY dispensed_at DESC')
      .all(prescriptionId);
    return rows as DispensingEvent[];
  }
}
