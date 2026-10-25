// repeatOrderService.ts — One-Tap Repeat Order Evaluation Engine
import { localDb } from '../../local-db';
import { InventoryAvailabilityService } from '../inventory/inventoryAvailabilityService';
import { AppError } from '../../lib/appError';

export interface RepeatOrderItemEvaluation {
  medicineId: string;
  medicineName: string;
  historicalQuantity: number;
  historicalPrice: number;
  currentPrice: number;
  priceChanged: boolean;
  status:
    | 'AVAILABLE'
    | 'PRICE_CHANGED'
    | 'PRESCRIPTION_REQUIRED'
    | 'UNAVAILABLE'
    | 'DISCONTINUED';
  availableStock: number;
  prescriptionRequired: boolean;
  isPrescriptionValid: boolean;
  notes?: string;
}

export interface RepeatOrderEvaluationResult {
  sourceType: 'SALE' | 'ORDER';
  sourceId: string;
  customerId: string;
  eligibleForOneTapOrder: boolean;
  totalItems: number;
  availableItemsCount: number;
  items: RepeatOrderItemEvaluation[];
}

export class RepeatOrderService {
  /**
   * Evaluate a previous sale or order for repeat ordering
   */
  static evaluateRepeatOrder(params: {
    sourceId: string;
    organizationId: string;
    storeId?: string | null;
  }): RepeatOrderEvaluationResult {
    const { sourceId, organizationId, storeId = null } = params;

    let customerId = '';
    let historicalLines: Array<{
      medicineId: string;
      quantity: number;
      historicalPrice: number;
      unitType?: string;
    }> = [];
    let sourceType: 'SALE' | 'ORDER' = 'SALE';

    // Check if sourceId matches a previous Sale
    const saleRow: any = localDb
      .prepare('SELECT * FROM sales WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(sourceId, sourceId, organizationId);

    if (saleRow) {
      sourceType = 'SALE';
      customerId = saleRow.customer_id || '';
      const saleItems: any[] = localDb
        .prepare('SELECT * FROM sale_items WHERE sale_id = ?')
        .all(saleRow.id || saleRow._local_id);

      historicalLines = saleItems.map(si => ({
        medicineId: si.medicine_id,
        quantity: Number(si.quantity || 1),
        historicalPrice: Number(si.unit_price || 0),
        unitType: si.unit_type || 'STRIP',
      }));
    } else {
      // Check if sourceId matches a previous Order
      const orderRow: any = localDb
        .prepare('SELECT * FROM orders WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
        .get(sourceId, sourceId, organizationId);

      if (!orderRow) {
        throw new AppError(404, 'Source historical sale or order not found', 'SOURCE_NOT_FOUND');
      }

      sourceType = 'ORDER';
      customerId = orderRow.customer_id;
      const orderItems: any[] = localDb
        .prepare('SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0')
        .all(orderRow.id || orderRow._local_id);

      historicalLines = orderItems.map(oi => ({
        medicineId: oi.medicine_id,
        quantity: Number(oi.requested_quantity || 1),
        historicalPrice: Number(oi.unit_price_paise || 0) / 100,
        unitType: oi.requested_unit || 'STRIP',
      }));
    }

    const items: RepeatOrderItemEvaluation[] = [];
    let availableCount = 0;

    for (const hl of historicalLines) {
      const medRow: any = localDb
        .prepare('SELECT * FROM medicines WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0')
        .get(hl.medicineId, hl.medicineId, organizationId);

      if (!medRow || medRow.discontinued_at || medRow.is_active === 0) {
        items.push({
          medicineId: hl.medicineId,
          medicineName: medRow?.name || 'Unknown Product',
          historicalQuantity: hl.quantity,
          historicalPrice: hl.historicalPrice,
          currentPrice: 0,
          priceChanged: false,
          status: 'DISCONTINUED',
          availableStock: 0,
          prescriptionRequired: Boolean(medRow?.prescription_required),
          isPrescriptionValid: false,
          notes: 'Product is discontinued or no longer active',
        });
        continue;
      }

      const currentPrice = Number(medRow.mrp || 0);
      const priceChanged = Math.abs(currentPrice - hl.historicalPrice) > 0.01;

      // Check current stock availability
      const avail = InventoryAvailabilityService.getAvailability({
        organizationId,
        medicineId: hl.medicineId,
        locationType: 'STORE',
        storeId,
      });

      const isStockAvailable = avail.totalAvailable >= hl.quantity;
      const isRxRequired = Boolean(medRow.prescription_required);

      // Check prescription validity if Rx required
      let isRxValid = false;
      if (isRxRequired && customerId) {
        const rxRow: any = localDb
          .prepare(
            `SELECT p.id, p.verification_status, p.valid_until 
             FROM prescriptions p 
             JOIN prescription_items pi ON (p.id = pi.prescription_id OR p._local_id = pi.prescription_id)
             WHERE p.patient_id = ? AND (pi.matched_product_id = ? OR pi.prescribed_name = ?)
               AND p.verification_status = 'VERIFIED' AND p._deleted = 0
             ORDER BY p.created_at DESC LIMIT 1`
          )
          .get(customerId, hl.medicineId, medRow.name);

        if (rxRow) {
          const isNotExpired = !rxRow.valid_until || new Date(rxRow.valid_until) >= new Date();
          isRxValid = isNotExpired;
        }
      }

      let status: RepeatOrderItemEvaluation['status'] = 'AVAILABLE';
      if (!isStockAvailable) {
        status = 'UNAVAILABLE';
      } else if (isRxRequired && !isRxValid) {
        status = 'PRESCRIPTION_REQUIRED';
      } else if (priceChanged) {
        status = 'PRICE_CHANGED';
      }

      if (isStockAvailable && (!isRxRequired || isRxValid)) {
        availableCount++;
      }

      items.push({
        medicineId: hl.medicineId,
        medicineName: medRow.name,
        historicalQuantity: hl.quantity,
        historicalPrice: hl.historicalPrice,
        currentPrice,
        priceChanged,
        status,
        availableStock: avail.totalAvailable,
        prescriptionRequired: isRxRequired,
        isPrescriptionValid: isRxValid,
        notes: isStockAvailable
          ? (priceChanged ? 'Price has changed since previous purchase' : 'In stock and ready')
          : `Out of stock (only ${avail.totalAvailable} available)`,
      });
    }

    const eligibleForOneTapOrder = availableCount === items.length && items.length > 0;

    return {
      sourceType,
      sourceId,
      customerId,
      eligibleForOneTapOrder,
      totalItems: items.length,
      availableItemsCount: availableCount,
      items,
    };
  }
}
