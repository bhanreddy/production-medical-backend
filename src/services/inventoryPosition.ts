import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { LocationType } from '../domain/units';

export interface InventoryPositionRecord {
  id: string;
  _local_id: string;
  organization_id: string;
  medicine_id: string;
  batch_id: string;
  location_type: LocationType;
  store_id: string | null;
  warehouse_id: string | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  quantity_quarantined: number;
  quantity_damaged: number;
  quantity_recalled: number;
  quantity_in_transit: number;
  quantity_on_hold: number;
  quantity_stocktake_locked: number;
  created_at: string;
  updated_at: string;
}

export class InventoryPositionService {
  /**
   * Helper to recalculate quantity_available consistently:
   * available = max(0, on_hand - (reserved + quarantined + damaged + recalled + on_hold + stocktake_locked))
   */
  static calcAvailable(
    onHand: number,
    reserved: number,
    quarantined: number,
    damaged: number,
    recalled: number,
    onHold: number,
    stocktakeLocked: number
  ): number {
    const unavailable =
      Number(reserved || 0) +
      Number(quarantined || 0) +
      Number(damaged || 0) +
      Number(recalled || 0) +
      Number(onHold || 0) +
      Number(stocktakeLocked || 0);
    return Math.max(0, Number(onHand || 0) - unavailable);
  }

  /**
   * Get or initialize an inventory position record for a location
   */
  static getOrCreatePosition(params: {
    organizationId: string;
    medicineId: string;
    batchId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    initialStock?: number;
  }): InventoryPositionRecord {
    const {
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId = null,
      warehouseId = null,
      initialStock = 0,
    } = params;

    const targetId = locationType === 'STORE' ? storeId : warehouseId;
    const locationCol = locationType === 'STORE' ? 'store_id' : 'warehouse_id';

    let row: any;
    if (targetId) {
      row = localDb
        .prepare(
          `SELECT * FROM inventory_positions 
           WHERE organization_id = ? AND medicine_id = ? AND batch_id = ? AND location_type = ? AND ${locationCol} = ?`
        )
        .get(organizationId, medicineId, batchId, locationType, targetId);
    } else {
      row = localDb
        .prepare(
          `SELECT * FROM inventory_positions 
           WHERE organization_id = ? AND medicine_id = ? AND batch_id = ? AND location_type = ? AND ${locationCol} IS NULL`
        )
        .get(organizationId, medicineId, batchId, locationType);
    }

    if (!row) {
      const id = uuidv4();
      const now = new Date().toISOString();
      const onHand = Math.max(0, initialStock);
      const available = onHand;

      localDb
        .prepare(
          `INSERT OR REPLACE INTO inventory_positions (
             id, _local_id, organization_id, medicine_id, batch_id, location_type,
             store_id, warehouse_id, quantity_on_hand, quantity_reserved,
             quantity_available, quantity_quarantined, quantity_damaged,
             quantity_recalled, quantity_in_transit, quantity_on_hold,
             quantity_stocktake_locked, created_at, updated_at, _updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?)`
        )
        .run(
          id,
          id,
          organizationId,
          medicineId,
          batchId,
          locationType,
          storeId,
          warehouseId,
          onHand,
          available,
          now,
          now,
          now
        );

      row = localDb
        .prepare('SELECT * FROM inventory_positions WHERE id = ?')
        .get(id);
    }

    return {
      ...row,
      quantity_on_hand: Number(row.quantity_on_hand || 0),
      quantity_reserved: Number(row.quantity_reserved || 0),
      quantity_available: Number(row.quantity_available || 0),
      quantity_quarantined: Number(row.quantity_quarantined || 0),
      quantity_damaged: Number(row.quantity_damaged || 0),
      quantity_recalled: Number(row.quantity_recalled || 0),
      quantity_in_transit: Number(row.quantity_in_transit || 0),
      quantity_on_hold: Number(row.quantity_on_hold || 0),
      quantity_stocktake_locked: Number(row.quantity_stocktake_locked || 0),
    } as InventoryPositionRecord;
  }

  /**
   * Atomically adjust stock on hand at a location
   */
  static adjustStock(params: {
    organizationId: string;
    medicineId: string;
    batchId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    quantityDelta: number;
  }): InventoryPositionRecord {
    const {
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId = null,
      warehouseId = null,
      quantityDelta,
    } = params;

    const pos = this.getOrCreatePosition({
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId,
      warehouseId,
    });

    const newOnHand = Number(pos.quantity_on_hand || 0) + quantityDelta;
    if (newOnHand < 0) {
      throw new Error(
        `Insufficient inventory position stock. Available: ${pos.quantity_on_hand}, Requested delta: ${quantityDelta}`
      );
    }

    const newAvailable = this.calcAvailable(
      newOnHand,
      pos.quantity_reserved,
      pos.quantity_quarantined,
      pos.quantity_damaged,
      pos.quantity_recalled,
      pos.quantity_on_hold,
      pos.quantity_stocktake_locked
    );
    const now = new Date().toISOString();

    localDb
      .prepare(
        `UPDATE inventory_positions
         SET quantity_on_hand = ?, quantity_available = ?, updated_at = ?, _updated_at = ?
         WHERE id = ? OR _local_id = ?`
      )
      .run(newOnHand, newAvailable, now, now, pos.id, pos._local_id);

    return {
      ...pos,
      quantity_on_hand: newOnHand,
      quantity_available: newAvailable,
      updated_at: now,
    };
  }

  /**
   * Update specific sub-state quantities (quarantined, damaged, recalled, reserved, etc.)
   */
  static updateStateQuantities(params: {
    organizationId: string;
    medicineId: string;
    batchId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    reservedDelta?: number;
    quarantinedDelta?: number;
    damagedDelta?: number;
    recalledDelta?: number;
    onHoldDelta?: number;
    stocktakeLockedDelta?: number;
    inTransitDelta?: number;
  }): InventoryPositionRecord {
    const {
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId = null,
      warehouseId = null,
      reservedDelta = 0,
      quarantinedDelta = 0,
      damagedDelta = 0,
      recalledDelta = 0,
      onHoldDelta = 0,
      stocktakeLockedDelta = 0,
      inTransitDelta = 0,
    } = params;

    const pos = this.getOrCreatePosition({
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId,
      warehouseId,
    });

    const newReserved = Math.max(0, Number(pos.quantity_reserved || 0) + reservedDelta);
    const newQuarantined = Math.max(0, Number(pos.quantity_quarantined || 0) + quarantinedDelta);
    const newDamaged = Math.max(0, Number(pos.quantity_damaged || 0) + damagedDelta);
    const newRecalled = Math.max(0, Number(pos.quantity_recalled || 0) + recalledDelta);
    const newOnHold = Math.max(0, Number(pos.quantity_on_hold || 0) + onHoldDelta);
    const newStocktakeLocked = Math.max(0, Number(pos.quantity_stocktake_locked || 0) + stocktakeLockedDelta);
    const newInTransit = Math.max(0, Number(pos.quantity_in_transit || 0) + inTransitDelta);

    const newAvailable = this.calcAvailable(
      pos.quantity_on_hand,
      newReserved,
      newQuarantined,
      newDamaged,
      newRecalled,
      newOnHold,
      newStocktakeLocked
    );
    const now = new Date().toISOString();

    localDb
      .prepare(
        `UPDATE inventory_positions
         SET quantity_reserved = ?, quantity_quarantined = ?, quantity_damaged = ?,
             quantity_recalled = ?, quantity_on_hold = ?, quantity_stocktake_locked = ?,
             quantity_in_transit = ?, quantity_available = ?, updated_at = ?, _updated_at = ?
         WHERE id = ? OR _local_id = ?`
      )
      .run(
        newReserved,
        newQuarantined,
        newDamaged,
        newRecalled,
        newOnHold,
        newStocktakeLocked,
        newInTransit,
        newAvailable,
        now,
        now,
        pos.id,
        pos._local_id
      );

    return {
      ...pos,
      quantity_reserved: newReserved,
      quantity_quarantined: newQuarantined,
      quantity_damaged: newDamaged,
      quantity_recalled: newRecalled,
      quantity_on_hold: newOnHold,
      quantity_stocktake_locked: newStocktakeLocked,
      quantity_in_transit: newInTransit,
      quantity_available: newAvailable,
      updated_at: now,
    };
  }
}

