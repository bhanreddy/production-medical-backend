// inventoryReservationService.ts — Enterprise Concurrency-Safe Stock Reservation Service
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import { ReservationSourceType, ReservationStatus } from '../../domain/inventoryTypes';
import { LocationType } from '../../domain/units';
import { InventoryPositionService } from '../inventoryPosition';
import { InventoryAvailabilityService } from './inventoryAvailabilityService';
import { AppError } from '../../lib/appError';

export class InventoryReservationService {
  /**
   * Create an inventory reservation with concurrency protection
   */
  static createReservation(params: {
    organizationId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    medicineId: string;
    batchId?: string | null;
    quantity: number;
    sourceType: ReservationSourceType;
    sourceId: string;
    durationMinutes?: number;
    createdBy?: string;
  }): { id: string; status: ReservationStatus; expiresAt: string } {
    const {
      organizationId,
      locationType,
      storeId = null,
      warehouseId = null,
      medicineId,
      batchId = null,
      quantity,
      sourceType,
      sourceId,
      durationMinutes = 60,
      createdBy = 'SYSTEM',
    } = params;

    // First, clean any expired reservations
    this.cleanExpiredReservations(organizationId);

    // Validate available stock
    const avail = InventoryAvailabilityService.getAvailability({
      organizationId,
      medicineId,
      locationType,
      storeId,
      warehouseId,
      batchId,
    });

    if (avail.totalAvailable < quantity) {
      throw new AppError(
        400,
        `Cannot reserve ${quantity} units of '${avail.medicineName}'. Only ${avail.totalAvailable} available.`,
        'INSUFFICIENT_AVAILABLE_STOCK'
      );
    }

    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    // If batchId is specified, lock that position; otherwise choose earliest FEFO batch
    let targetBatchId = batchId;
    if (!targetBatchId && avail.sellableBatches.length > 0) {
      targetBatchId = avail.sellableBatches[0].batchId;
    }

    localDb
      .prepare(
        `INSERT INTO inventory_reservations (
          id, _local_id, organization_id, location_type, store_id, warehouse_id,
          medicine_id, batch_id, quantity, source_type, source_id, expires_at,
          status, created_by, created_at, updated_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        organizationId,
        locationType,
        storeId,
        warehouseId,
        medicineId,
        targetBatchId,
        quantity,
        sourceType,
        sourceId,
        expiresAt,
        createdBy,
        nowIso,
        nowIso,
        nowIso
      );

    // Update position reserved quantity
    if (targetBatchId) {
      InventoryPositionService.updateStateQuantities({
        organizationId,
        medicineId,
        batchId: targetBatchId,
        locationType,
        storeId,
        warehouseId,
        reservedDelta: quantity,
      });
    }

    return {
      id,
      status: 'ACTIVE',
      expiresAt,
    };
  }

  /**
   * Consume reservation when sale / transfer completes
   */
  static consumeReservation(reservationId: string): void {
    const row: any = localDb
      .prepare('SELECT * FROM inventory_reservations WHERE id = ? OR _local_id = ?')
      .get(reservationId, reservationId);

    if (!row || row.status !== 'ACTIVE') return;

    const now = new Date().toISOString();
    localDb
      .prepare(
        `UPDATE inventory_reservations 
         SET status = 'CONSUMED', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, row.id);

    // Release reserved quantity from position
    if (row.batch_id) {
      InventoryPositionService.updateStateQuantities({
        organizationId: row.organization_id,
        medicineId: row.medicine_id,
        batchId: row.batch_id,
        locationType: row.location_type,
        storeId: row.store_id,
        warehouseId: row.warehouse_id,
        reservedDelta: -Number(row.quantity || 0),
      });
    }
  }

  /**
   * Release reservation explicitly
   */
  static releaseReservation(reservationId: string): void {
    const row: any = localDb
      .prepare('SELECT * FROM inventory_reservations WHERE id = ? OR _local_id = ?')
      .get(reservationId, reservationId);

    if (!row || row.status !== 'ACTIVE') return;

    const now = new Date().toISOString();
    localDb
      .prepare(
        `UPDATE inventory_reservations 
         SET status = 'RELEASED', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, row.id);

    // Release reserved quantity from position
    if (row.batch_id) {
      InventoryPositionService.updateStateQuantities({
        organizationId: row.organization_id,
        medicineId: row.medicine_id,
        batchId: row.batch_id,
        locationType: row.location_type,
        storeId: row.store_id,
        warehouseId: row.warehouse_id,
        reservedDelta: -Number(row.quantity || 0),
      });
    }
  }

  /**
   * Clean expired reservations
   */
  static cleanExpiredReservations(organizationId: string): number {
    const nowIso = new Date().toISOString();
    const expiredRows: any[] = localDb
      .prepare(
        `SELECT * FROM inventory_reservations 
         WHERE organization_id = ? AND status = 'ACTIVE' AND expires_at < ?`
      )
      .all(organizationId, nowIso);

    for (const r of expiredRows) {
      localDb
        .prepare(
          `UPDATE inventory_reservations 
           SET status = 'EXPIRED', updated_at = ?, _updated_at = ?
           WHERE id = ?`
        )
        .run(nowIso, nowIso, r.id);

      if (r.batch_id) {
        InventoryPositionService.updateStateQuantities({
          organizationId: r.organization_id,
          medicineId: r.medicine_id,
          batchId: r.batch_id,
          locationType: r.location_type,
          storeId: r.store_id,
          warehouseId: r.warehouse_id,
          reservedDelta: -Number(r.quantity || 0),
        });
      }
    }

    return expiredRows.length;
  }
}
