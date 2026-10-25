// orderReservationService.ts — Concurrency-Safe Order Stock Reservation Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { InventoryReservationService } from '../inventory/inventoryReservationService';
import { InventoryAvailabilityService } from '../inventory/inventoryAvailabilityService';
import { FEFOEngine } from '../fefoEngine';
import { AppError } from '../../lib/appError';

export interface OrderItemAllocation {
  orderItemId: string;
  medicineId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantityAllocated: number;
  reservationId: string;
}

export class OrderReservationService {
  /** Default reservation duration in minutes (120 mins = 2 hours) */
  static readonly DEFAULT_HOLD_MINUTES = 120;

  /**
   * Reserve stock across FEFO batches for an order's items at a specific store
   */
  static reserveOrderStock(params: {
    orderId: string;
    organizationId: string;
    storeId: string;
    items: Array<{
      orderItemId: string;
      medicineId: string;
      baseQuantity: number;
    }>;
    holdDurationMinutes?: number;
    createdBy?: string;
  }): OrderItemAllocation[] {
    const {
      orderId,
      organizationId,
      storeId,
      items,
      holdDurationMinutes = this.DEFAULT_HOLD_MINUTES,
      createdBy = 'SYSTEM',
    } = params;

    const allocations: OrderItemAllocation[] = [];

    // Run inside an atomic transaction to ensure all or nothing reservation
    const reserveTx = localDb.transaction(() => {
      for (const item of items) {
        let remainingToReserve = item.baseQuantity;

        // Query available non-expired sellable batches for this medicine in FEFO order
        const avail = InventoryAvailabilityService.getAvailability({
          organizationId,
          medicineId: item.medicineId,
          locationType: 'STORE',
          storeId,
        });

        if (avail.totalAvailable < remainingToReserve) {
          throw new AppError(
            409,
            `Insufficient stock to reserve '${avail.medicineName}'. Required ${remainingToReserve}, but only ${avail.totalAvailable} available at Store.`,
            'INSUFFICIENT_AVAILABLE_STOCK'
          );
        }

        // Allocate across sellable batches in strict FEFO order
        for (const batch of avail.sellableBatches) {
          if (remainingToReserve <= 0) break;

          const allocQty = Math.min(remainingToReserve, batch.quantityAvailable);
          if (allocQty <= 0) continue;

          // Create authoritative reservation in Task 5 engine
          const res = InventoryReservationService.createReservation({
            organizationId,
            locationType: 'STORE',
            storeId,
            medicineId: item.medicineId,
            batchId: batch.batchId,
            quantity: allocQty,
            sourceType: 'ORDER',
            sourceId: orderId,
            durationMinutes: holdDurationMinutes,
            createdBy,
          });

          allocations.push({
            orderItemId: item.orderItemId,
            medicineId: item.medicineId,
            batchId: batch.batchId,
            batchNumber: batch.batchNumber,
            expiryDate: batch.expiryDate,
            quantityAllocated: allocQty,
            reservationId: res.id,
          });

          remainingToReserve -= allocQty;
        }

        if (remainingToReserve > 0) {
          throw new AppError(
            409,
            `Could not satisfy full FEFO allocation for '${avail.medicineName}'. ${remainingToReserve} units unallocated.`,
            'BATCH_ALLOCATION_SHORTAGE'
          );
        }
      }
    });

    reserveTx();
    return allocations;
  }

  /**
   * Get all reservations associated with an order
   */
  static getOrderReservations(orderId: string): any[] {
    return localDb
      .prepare(`SELECT * FROM inventory_reservations WHERE source_id = ?`)
      .all(orderId);
  }

  /**
   * Release all active reservations associated with an order
   */
  static releaseOrderReservations(orderId: string, organizationId: string): void {
    const rows: any[] = localDb
      .prepare(
        `SELECT id FROM inventory_reservations 
         WHERE source_id = ? AND organization_id = ? AND status = 'ACTIVE'`
      )
      .all(orderId, organizationId);

    for (const r of rows) {
      InventoryReservationService.releaseReservation(r.id);
    }
  }

  /**
   * Consume all active reservations associated with an order (called during final sale completion)
   */
  static consumeOrderReservations(orderId: string, organizationId: string): void {
    const rows: any[] = localDb
      .prepare(
        `SELECT id FROM inventory_reservations 
         WHERE source_id = ? AND organization_id = ? AND status = 'ACTIVE'`
      )
      .all(orderId, organizationId);

    for (const r of rows) {
      InventoryReservationService.consumeReservation(r.id);
    }
  }
}
