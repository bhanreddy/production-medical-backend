// inventoryAvailabilityService.ts — Centralized Inventory Availability Service
import { AppError } from '../../lib/appError';
import { localDb } from '../../local-db';
import {
  InventoryAvailabilityResult,
  BatchAvailabilitySummary,
  InventoryState,
} from '../../domain/inventoryTypes';
import { LocationType } from '../../domain/units';
import { InventoryPositionService } from '../inventoryPosition';

export class InventoryAvailabilityService {
  /**
   * Check inventory availability for a medicine at a specific location
   */
  static getAvailability(params: {
    organizationId: string;
    medicineId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    batchId?: string | null;
    requestedQuantity?: number;
  }): InventoryAvailabilityResult {
    const {
      organizationId,
      medicineId,
      locationType,
      storeId = null,
      warehouseId = null,
      batchId = null,
      requestedQuantity = 0,
    } = params;

    const medRow: any = localDb
      .prepare('SELECT id, name FROM medicines WHERE (id = ? OR _local_id = ?) AND organization_id = ? AND _deleted = 0')
      .get(medicineId, medicineId, organizationId);

    if (!medRow) throw new AppError(404, 'Medicine not found');
    const medicineName = medRow.name;
    const targetId = locationType === 'STORE' ? storeId : warehouseId;
    const locationCol = locationType === 'STORE' ? 'store_id' : 'warehouse_id';

    // Retrieve active recalls affecting this medicine or batches
    const activeRecalls: any[] = localDb
      .prepare(
        `SELECT product_id, batch_id FROM product_recalls 
         WHERE organization_id = ? AND status = 'ACTIVE' AND (product_id = ? OR product_id = ?)`
      )
      .all(organizationId, medicineId, medicineId);

    const isProductRecalled = activeRecalls.some(
      (r) => !r.batch_id || r.batch_id === null
    );
    const recalledBatchIds = new Set(
      activeRecalls.map((r) => r.batch_id).filter(Boolean)
    );

    // Retrieve batches for this medicine
    let batchQuery = `
      SELECT mb.*, 
             COALESCE(ip.quantity_on_hand, (CASE WHEN mb.store_id = ? OR (? IS NULL AND mb.store_id IS NULL) THEN mb.quantity_remaining ELSE 0 END)) as pos_on_hand,
             COALESCE(ip.quantity_available, (CASE WHEN mb.store_id = ? OR (? IS NULL AND mb.store_id IS NULL) THEN mb.quantity_remaining ELSE 0 END)) as pos_available,
             COALESCE(ip.quantity_reserved, 0) as pos_reserved,
             COALESCE(ip.quantity_quarantined, 0) as pos_quarantined,
             COALESCE(ip.quantity_damaged, 0) as pos_damaged,
             COALESCE(ip.quantity_recalled, 0) as pos_recalled,
             COALESCE(ip.quantity_in_transit, 0) as pos_in_transit,
             COALESCE(ip.quantity_on_hold, 0) as pos_on_hold,
             COALESCE(ip.quantity_stocktake_locked, 0) as pos_stocktake_locked
      FROM medicine_batches mb
      LEFT JOIN inventory_positions ip 
        ON ip.batch_id = mb.id 
        AND ip.organization_id = ? 
        AND ip.location_type = ? 
        AND ${targetId ? `ip.${locationCol} = ?` : `ip.${locationCol} IS NULL`}
      WHERE mb.medicine_id = ? AND (mb.organization_id = ? OR mb.organization_id IS NULL) AND (mb._deleted = 0 OR mb._deleted IS NULL) AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
    `;

    const queryParams: any[] = targetId
      ? [targetId, targetId, targetId, targetId, organizationId, locationType, targetId, medRow.id, organizationId]
      : [null, null, null, null, organizationId, locationType, medRow.id, organizationId];

    if (batchId) {
      batchQuery += ` AND (mb.id = ? OR mb._local_id = ?)`;
      queryParams.push(batchId, batchId);
    }

    batchQuery += ` ORDER BY mb.expiry_date ASC`;

    const rawBatches: any[] = localDb.prepare(batchQuery).all(...queryParams);
    const todayStr = new Date().toISOString().split('T')[0];

    const batches: BatchAvailabilitySummary[] = [];
    const sellableBatches: BatchAvailabilitySummary[] = [];
    let totalOnHand = 0;
    let totalAvailable = 0;
    let totalReserved = 0;
    let totalBlocked = 0;
    let totalInTransit = 0;
    let nearestExpiryDate: string | null = null;
    const warnings: string[] = [];

    for (const b of rawBatches) {
      const onHand = Number(b.pos_on_hand || 0);
      const reserved = Number(b.pos_reserved || 0);
      const quarantined = Number(b.pos_quarantined || 0);
      const damaged = Number(b.pos_damaged || 0);
      const recalled = Number(b.pos_recalled || 0);
      const inTransit = Number(b.pos_in_transit || 0);
      const onHold = Number(b.pos_on_hold || 0);
      const stocktakeLocked = Number(b.pos_stocktake_locked || 0);

      const isExpired = b.expiry_date ? String(b.expiry_date) < todayStr : false;
      const isRecalled = isProductRecalled || recalledBatchIds.has(b.id) || recalled > 0;
      const isQuarantined = quarantined > 0;
      const isDamaged = damaged > 0;
      const isStocktakeLocked = stocktakeLocked > 0;

      // Available calculation
      const calculatedAvailable = InventoryPositionService.calcAvailable(
        onHand,
        reserved,
        quarantined,
        damaged,
        recalled,
        onHold,
        stocktakeLocked
      );

      // If expired, available stock for selling is 0
      const effectiveAvailable = isExpired || isRecalled ? 0 : calculatedAvailable;
      const blockedUnits = onHand - effectiveAvailable - reserved;

      totalOnHand += onHand;
      totalAvailable += effectiveAvailable;
      totalReserved += reserved;
      totalBlocked += Math.max(0, blockedUnits);
      totalInTransit += inTransit;

      if (!nearestExpiryDate && b.expiry_date && !isExpired) {
        nearestExpiryDate = b.expiry_date;
      }

      const summary: BatchAvailabilitySummary = {
        batchId: b.id || b._local_id,
        batchNumber: b.batch_number || 'UNKNOWN',
        expiryDate: b.expiry_date || '',
        quantityOnHand: onHand,
        quantityAvailable: effectiveAvailable,
        quantityReserved: reserved,
        isExpired,
        isRecalled,
        isQuarantined,
        isDamaged,
        isStocktakeLocked,
        unitCostPaise: Number(b.cost_price_paise || Math.round((b.purchase_price || 0) * 100)),
        mrpPaise: Number(b.mrp_paise || Math.round((b.mrp || 0) * 100)),
      };

      batches.push(summary);

      if (effectiveAvailable > 0 && !isExpired && !isRecalled && !isStocktakeLocked) {
        sellableBatches.push(summary);
      }
    }

    // Determine state
    let stockState: InventoryState = 'AVAILABLE';
    if (totalOnHand === 0) {
      stockState = 'AVAILABLE'; // 0 stock
    } else if (totalAvailable === 0) {
      if (isProductRecalled || batches.every((b) => b.isRecalled)) {
        stockState = 'RECALLED';
      } else if (batches.every((b) => b.isExpired)) {
        stockState = 'EXPIRED';
      } else if (batches.every((b) => b.isQuarantined)) {
        stockState = 'QUARANTINED';
      } else if (batches.every((b) => b.isDamaged)) {
        stockState = 'DAMAGED';
      } else if (totalReserved >= totalOnHand) {
        stockState = 'RESERVED';
      } else {
        stockState = 'ON_HOLD';
      }
    }

    if (requestedQuantity > 0 && totalAvailable < requestedQuantity) {
      warnings.push(
        `Insufficient available stock for '${medicineName}'. Requested: ${requestedQuantity}, Available: ${totalAvailable}`
      );
    }

    if (isProductRecalled) {
      warnings.push(`Product '${medicineName}' is under an ACTIVE recall.`);
    }

    return {
      medicineId,
      medicineName,
      organizationId,
      locationType,
      storeId,
      warehouseId,
      totalOnHand,
      totalAvailable,
      totalReserved,
      totalBlocked,
      totalInTransit,
      batches,
      sellableBatches,
      nearestExpiryDate,
      stockState,
      warnings,
    };
  }

  /**
   * Search cross-store availability for a product across other stores/warehouses in the organization
   */
  static getCrossLocationAvailability(params: {
    organizationId: string;
    medicineId: string;
    currentStoreId?: string | null;
  }): {
    currentStoreAvailable: number;
    otherLocations: {
      locationType: 'STORE' | 'WAREHOUSE';
      id: string;
      code: string;
      name: string;
      availableUnits: number;
      onHandUnits: number;
    }[];
  } {
    const { organizationId, medicineId, currentStoreId = null } = params;

    let currentStoreAvailable = 0;
    if (currentStoreId) {
      const cur = this.getAvailability({
        organizationId,
        medicineId,
        locationType: 'STORE',
        storeId: currentStoreId,
      });
      currentStoreAvailable = cur.totalAvailable;
    }

    const otherLocations: any[] = [];

    // Other Stores
    const stores: any[] = localDb
      .prepare(
        `SELECT id, store_code, name FROM stores 
         WHERE organization_id = ? ${currentStoreId ? 'AND id != ?' : ''}`
      )
      .all(...(currentStoreId ? [organizationId, currentStoreId] : [organizationId]));

    for (const s of stores) {
      const avail = this.getAvailability({
        organizationId,
        medicineId,
        locationType: 'STORE',
        storeId: s.id,
      });
      if (avail.totalOnHand > 0) {
        otherLocations.push({
          locationType: 'STORE',
          id: s.id,
          code: s.store_code,
          name: s.name,
          availableUnits: avail.totalAvailable,
          onHandUnits: avail.totalOnHand,
        });
      }
    }

    // Warehouses
    const warehouses: any[] = localDb
      .prepare('SELECT id, warehouse_code, name FROM warehouses WHERE organization_id = ?')
      .all(organizationId);

    for (const w of warehouses) {
      const avail = this.getAvailability({
        organizationId,
        medicineId,
        locationType: 'WAREHOUSE',
        warehouseId: w.id,
      });
      if (avail.totalOnHand > 0) {
        otherLocations.push({
          locationType: 'WAREHOUSE',
          id: w.id,
          code: w.warehouse_code,
          name: w.name,
          availableUnits: avail.totalAvailable,
          onHandUnits: avail.totalOnHand,
        });
      }
    }

    return {
      currentStoreAvailable,
      otherLocations,
    };
  }
}
