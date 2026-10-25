import { localDb } from '../local-db';
import { AppError } from '../lib/appError';

export interface BatchCandidate {
  id: string;
  _local_id: string;
  batch_number: string;
  expiry_date: string;
  quantity_remaining: number;
  mrp: number;
  purchase_price: number;
  is_disposed?: boolean | number;
}

export interface ExpirySafetyEvaluation {
  status: 'SAFE' | 'NEAR_EXPIRY_90D' | 'NEAR_EXPIRY_60D' | 'NEAR_EXPIRY_30D' | 'EXPIRED';
  severity: 'NONE' | 'INFO' | 'WARNING' | 'BLOCKING';
  daysToExpiry: number;
  message: string;
  approvalRequired: boolean;
}

export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  allocatedQuantity: number;
  mrp: number;
  purchasePrice: number;
  safety: ExpirySafetyEvaluation;
}

export class FEFOEngine {
  /**
   * Evaluates expiry safety for a given batch expiry date
   */
  static evaluateExpirySafety(expiryDateStr: string, asOf: Date = new Date()): ExpirySafetyEvaluation {
    const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const expiry = new Date(expiryDateStr);
    const diffMs = expiry.getTime() - today.getTime();
    const daysToExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysToExpiry < 0) {
      return {
        status: 'EXPIRED',
        severity: 'BLOCKING',
        daysToExpiry,
        message: `Batch is expired (${expiryDateStr}). Sale is strictly prohibited.`,
        approvalRequired: true,
      };
    }

    if (daysToExpiry <= 30) {
      return {
        status: 'NEAR_EXPIRY_30D',
        severity: 'WARNING',
        daysToExpiry,
        message: `Critical near-expiry: Expires in ${daysToExpiry} days (${expiryDateStr}). Pharmacist approval advised.`,
        approvalRequired: true,
      };
    }

    if (daysToExpiry <= 60) {
      return {
        status: 'NEAR_EXPIRY_60D',
        severity: 'WARNING',
        daysToExpiry,
        message: `Near-expiry: Expires in ${daysToExpiry} days (${expiryDateStr}).`,
        approvalRequired: false,
      };
    }

    if (daysToExpiry <= 90) {
      return {
        status: 'NEAR_EXPIRY_90D',
        severity: 'INFO',
        daysToExpiry,
        message: `Short shelf-life: Expires in ${daysToExpiry} days (${expiryDateStr}).`,
        approvalRequired: false,
      };
    }

    return {
      status: 'SAFE',
      severity: 'NONE',
      daysToExpiry,
      message: 'Batch is within safe shelf-life window.',
      approvalRequired: false,
    };
  }

  /**
   * Plans FEFO allocations across available batches for a medicine.
   */
  static planAllocations(params: {
    medicineId: string;
    storeId: string;
    organizationId: string;
    requestedQuantity: number;
    manualBatchId?: string | null;
    asOf?: Date;
  }): {
    allocations: BatchAllocation[];
    totalAllocated: number;
    recommendedBatchId: string | null;
    hasNearExpiryWarning: boolean;
    hasBlockingExpired: boolean;
  } {
    const {
      medicineId,
      storeId,
      organizationId,
      requestedQuantity,
      manualBatchId = null,
      asOf = new Date(),
    } = params;

    if (requestedQuantity <= 0) {
      throw new AppError(400, 'Requested quantity must be greater than 0', 'INVALID_QUANTITY');
    }

    const todayStr = asOf.toISOString().split('T')[0];

    // Query non-disposed, non-deleted batches with available stock for this store
    const rawBatches: any[] = localDb
      .prepare(
        `SELECT mb.*, 
                COALESCE(ip.quantity_on_hand, mb.quantity_remaining, 0) as pos_on_hand,
                COALESCE(ip.quantity_available, mb.quantity_remaining, 0) as pos_available,
                COALESCE(ip.quantity_quarantined, 0) as pos_quarantined,
                COALESCE(ip.quantity_damaged, 0) as pos_damaged,
                COALESCE(ip.quantity_recalled, 0) as pos_recalled,
                COALESCE(ip.quantity_stocktake_locked, 0) as pos_locked
         FROM medicine_batches mb
         LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id AND ip.organization_id = ?
           AND (ip.store_id = ? OR ip.store_id IS NULL)
         WHERE (mb.medicine_id = ? OR mb.medicine_id = ?)
           AND (mb.store_id = ? OR mb.store_id IS NULL)
           AND mb.quantity_remaining > 0
           AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
           AND mb._deleted = 0
         ORDER BY mb.expiry_date ASC`
      )
      .all(organizationId, storeId, medicineId, medicineId, storeId);

    // Active recalls check
    const activeRecalls: any[] = localDb
      .prepare(
        `SELECT batch_id FROM product_recalls 
         WHERE organization_id = ? AND status = 'ACTIVE' AND (product_id = ? OR product_id = ?)`
      )
      .all(organizationId, medicineId, medicineId);
    const recalledBatchIds = new Set(activeRecalls.map((r) => r.batch_id).filter(Boolean));
    const isAllRecalled = activeRecalls.some((r) => !r.batch_id);

    const batches = rawBatches.filter((b) => {
      if (isAllRecalled || recalledBatchIds.has(b.id) || Number(b.pos_recalled || 0) > 0) return false;
      if (Number(b.pos_quarantined || 0) > 0 || Number(b.pos_damaged || 0) > 0 || Number(b.pos_locked || 0) > 0) return false;
      return true;
    });

    if (batches.length === 0) {
      throw new AppError(409, 'No active sellable batches available for medicine in this store', 'NO_STOCK_AVAILABLE');
    }

    // Identify recommended batch (earliest non-expired)
    const validNonExpired = batches.filter(b => b.expiry_date >= todayStr);
    const recommendedBatchId = validNonExpired.length > 0 ? (validNonExpired[0].id || validNonExpired[0]._local_id) : null;

    let allocations: BatchAllocation[] = [];
    let remainingToAllocate = requestedQuantity;
    let hasNearExpiryWarning = false;
    let hasBlockingExpired = false;

    if (manualBatchId) {
      // Manual batch override flow
      const targetBatch = batches.find(b => b.id === manualBatchId || b._local_id === manualBatchId);
      if (!targetBatch) {
        throw new AppError(404, `Selected batch ${manualBatchId} not found or out of stock`, 'BATCH_NOT_FOUND');
      }

      const safety = this.evaluateExpirySafety(targetBatch.expiry_date, asOf);
      if (safety.severity === 'BLOCKING') {
        throw new AppError(400, `Cannot select expired batch (${targetBatch.expiry_date})`, 'EXPIRED_BATCH_BLOCKED');
      }

      const available = Number(targetBatch.quantity_remaining || 0);
      if (available < requestedQuantity) {
        throw new AppError(
          409,
          `Selected batch ${targetBatch.batch_number} has only ${available} units available (requested ${requestedQuantity})`,
          'INSUFFICIENT_BATCH_STOCK'
        );
      }

      allocations.push({
        batchId: targetBatch.id || targetBatch._local_id,
        batchNumber: targetBatch.batch_number,
        expiryDate: targetBatch.expiry_date,
        allocatedQuantity: requestedQuantity,
        mrp: Number(targetBatch.mrp || 0),
        purchasePrice: Number(targetBatch.purchase_price || 0),
        safety,
      });

      if (safety.severity === 'WARNING') hasNearExpiryWarning = true;
    } else {
      // Standard FEFO multi-batch allocation (filtering out expired batches)
      for (const batch of validNonExpired) {
        if (remainingToAllocate <= 0) break;

        const available = Number(batch.quantity_remaining || 0);
        const take = Math.min(remainingToAllocate, available);
        const safety = this.evaluateExpirySafety(batch.expiry_date, asOf);

        allocations.push({
          batchId: batch.id || batch._local_id,
          batchNumber: batch.batch_number,
          expiryDate: batch.expiry_date,
          allocatedQuantity: take,
          mrp: Number(batch.mrp || 0),
          purchasePrice: Number(batch.purchase_price || 0),
          safety,
        });

        if (safety.severity === 'WARNING') hasNearExpiryWarning = true;
        if (safety.severity === 'BLOCKING') hasBlockingExpired = true;

        remainingToAllocate -= take;
      }

      if (remainingToAllocate > 0) {
        const totalAvailable = validNonExpired.reduce((sum, b) => sum + Number(b.quantity_remaining || 0), 0);
        throw new AppError(
          409,
          `Insufficient non-expired stock. Requested: ${requestedQuantity}, Total available: ${totalAvailable}`,
          'INSUFFICIENT_STOCK'
        );
      }
    }

    return {
      allocations,
      totalAllocated: requestedQuantity,
      recommendedBatchId,
      hasNearExpiryWarning,
      hasBlockingExpired,
    };
  }
}
