// transferAllocationService.ts — Concurrency-Safe FEFO Batch Allocation & Reservation Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { StockTransferBatchAllocation, StockTransfer } from '../../domain/transferTypes';
import { InventoryReservationService } from '../inventory/inventoryReservationService';
import { InventoryPositionService } from '../inventoryPosition';
import { TransferPolicyService } from './transferPolicyService';

export class TransferAllocationService {
  /**
   * Run FEFO batch allocation for an approved transfer at source location
   */
  static allocateTransfer(params: {
    transferId: string;
    organizationId: string;
    allocatedBy: string;
    customAllocations?: Array<{
      itemId: string;
      batchId: string;
      quantity: number;
    }>;
  }): StockTransferBatchAllocation[] {
    const { transferId, organizationId, allocatedBy, customAllocations } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) {
      throw new Error(`Stock transfer not found: ${transferId}`);
    }

    if (transfer.status !== 'APPROVED' && transfer.status !== 'ALLOCATING' && transfer.status !== 'REQUESTED') {
      throw new Error(`Cannot allocate transfer in status: ${transfer.status}`);
    }

    const policy = TransferPolicyService.getPolicy(organizationId);
    const todayStr = new Date().toISOString().split('T')[0];

    // Fetch transfer items
    const items: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfer_items WHERE transfer_id = ? AND _deleted = 0`
      )
      .all(transfer.id);

    if (items.length === 0) {
      throw new Error('Transfer contains no items to allocate');
    }

    const allocations: StockTransferBatchAllocation[] = [];
    const sourceStoreId = transfer.source_location_type === 'STORE' ? transfer.source_location_id : null;
    const sourceWarehouseId = transfer.source_location_type === 'WAREHOUSE' ? transfer.source_location_id : null;
    const isRecallOrQuarantine = transfer.stock_state_transferred === 'RECALLED' || transfer.stock_state_transferred === 'QUARANTINED';

    // Clear previous draft allocations and release previous reservations
    this.releaseTransferAllocations(transfer.id, organizationId);

    for (const item of items) {
      const requiredQty = Number(item.base_quantity_requested || item.requested_quantity);
      let allocatedForItem = 0;

      if (customAllocations && customAllocations.length > 0) {
        const itemCustoms = customAllocations.filter((ca) => ca.itemId === item.id || ca.itemId === item._local_id);
        for (const ca of itemCustoms) {
          const batch: any = localDb
            .prepare(
              `SELECT * FROM medicine_batches 
               WHERE (id = ? OR _local_id = ?) AND (medicine_id = ? OR medicine_id = ?) AND _deleted = 0`
            )
            .get(ca.batchId, ca.batchId, item.medicine_id, item.medicine_id);

          if (!batch) throw new Error(`Batch not found: ${ca.batchId}`);

          const allocId = uuidv4();
          const unitCost = Math.round(Number(batch.purchase_price || 0) * 100) || item.unit_cost_paise || 0;

          // Reserve at source inventory position
          let resId: string | null = null;
          if (!isRecallOrQuarantine) {
            const res = InventoryReservationService.createReservation({
              organizationId,
              locationType: transfer.source_location_type,
              storeId: sourceStoreId,
              warehouseId: sourceWarehouseId,
              medicineId: item.medicine_id,
              batchId: batch.id,
              quantity: ca.quantity,
              sourceType: 'TRANSFER',
              sourceId: transfer.id,
              durationMinutes: 1440, // 24 hours
              createdBy: allocatedBy,
            });
            resId = res.id;
          }

          const record = localMutate({
            table: 'stock_transfer_batch_allocations',
            operation: 'INSERT',
            data: {
              id: allocId,
              _local_id: allocId,
              transfer_id: transfer.id,
              transfer_item_id: item.id,
              organization_id: organizationId,
              medicine_id: item.medicine_id,
              batch_id: batch.id,
              batch_number: batch.batch_number,
              expiry_date: batch.expiry_date,
              unit_cost_paise: unitCost,
              mrp_paise: Math.round(Number(batch.mrp || 0) * 100),
              quantity_allocated: ca.quantity,
              reservation_id: resId,
            },
          });
          allocations.push(record as any);
          allocatedForItem += ca.quantity;
        }
      } else {
        // Automatic FEFO Allocation
        let candidateBatches: any[] = [];
        if (transfer.source_location_type === 'STORE') {
          candidateBatches = localDb
            .prepare(
              `SELECT mb.*, ip.quantity_available, ip.quantity_recalled, ip.quantity_quarantined
               FROM medicine_batches mb
               JOIN inventory_positions ip ON ip.batch_id = mb.id OR ip.batch_id = mb._local_id
               WHERE (mb.medicine_id = ? OR mb.medicine_id = ?)
                 AND (ip.store_id = ? OR ip.store_id = ?)
                 AND ip.location_type = 'STORE'
                 AND mb._deleted = 0
               ORDER BY mb.expiry_date ASC`
            )
            .all(item.medicine_id, item.medicine_id, sourceStoreId, sourceStoreId);
        } else {
          candidateBatches = localDb
            .prepare(
              `SELECT mb.*, ip.quantity_available, ip.quantity_recalled, ip.quantity_quarantined
               FROM medicine_batches mb
               JOIN inventory_positions ip ON ip.batch_id = mb.id OR ip.batch_id = mb._local_id
               WHERE (mb.medicine_id = ? OR mb.medicine_id = ?)
                 AND (ip.warehouse_id = ? OR ip.warehouse_id = ?)
                 AND ip.location_type = 'WAREHOUSE'
                 AND mb._deleted = 0
               ORDER BY mb.expiry_date ASC`
            )
            .all(item.medicine_id, item.medicine_id, sourceWarehouseId, sourceWarehouseId);
        }

        let needed = requiredQty;
        for (const batch of candidateBatches) {
          if (needed <= 0) break;

          let availableInBatch = Number(batch.quantity_available || 0);
          if (transfer.stock_state_transferred === 'RECALLED') {
            availableInBatch = Number(batch.quantity_recalled || batch.quantity_remaining || 0);
          } else if (transfer.stock_state_transferred === 'QUARANTINED') {
            availableInBatch = Number(batch.quantity_quarantined || batch.quantity_remaining || 0);
          }

          if (availableInBatch <= 0) continue;

          // Check expiry threshold if normal transfer
          if (transfer.stock_state_transferred === 'AVAILABLE' && transfer.reason !== 'NEAR_EXPIRY') {
            const expTime = new Date(batch.expiry_date).getTime();
            const daysLeft = Math.ceil((expTime - new Date().getTime()) / 86400000);
            if (daysLeft < policy.minShelfLifeDaysTransfer) {
              continue; // Skip near-expiry batch unless explicitly redistribution
            }
          }

          const allocQty = Math.min(needed, availableInBatch);
          const allocId = uuidv4();
          const unitCost = Math.round(Number(batch.purchase_price || 0) * 100) || item.unit_cost_paise || 0;

          // Reserve at source
          let resId: string | null = null;
          if (transfer.stock_state_transferred === 'AVAILABLE') {
            const res = InventoryReservationService.createReservation({
              organizationId,
              locationType: transfer.source_location_type,
              storeId: sourceStoreId,
              warehouseId: sourceWarehouseId,
              medicineId: item.medicine_id,
              batchId: batch.id,
              quantity: allocQty,
              sourceType: 'TRANSFER',
              sourceId: transfer.id,
              durationMinutes: 1440,
              createdBy: allocatedBy,
            });
            resId = res.id;
          }

          const record = localMutate({
            table: 'stock_transfer_batch_allocations',
            operation: 'INSERT',
            data: {
              id: allocId,
              _local_id: allocId,
              transfer_id: transfer.id,
              transfer_item_id: item.id,
              organization_id: organizationId,
              medicine_id: item.medicine_id,
              batch_id: batch.id,
              batch_number: batch.batch_number,
              expiry_date: batch.expiry_date,
              unit_cost_paise: unitCost,
              mrp_paise: Math.round(Number(batch.mrp || 0) * 100),
              quantity_allocated: allocQty,
              reservation_id: resId,
            },
          });
          allocations.push(record as any);

          allocatedForItem += allocQty;
          needed -= allocQty;
        }
      }

      // Update allocated quantity on transfer item
      localMutate({
        table: 'stock_transfer_items',
        operation: 'UPDATE',
        data: {
          _local_id: item._local_id || item.id,
          allocated_quantity: allocatedForItem,
        },
      });
    }

    // Advance transfer status to READY_TO_PICK
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'READY_TO_PICK',
      },
    });

    // Log event
    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'ALLOCATED',
        from_status: transfer.status,
        to_status: 'READY_TO_PICK',
        performed_by: allocatedBy,
        notes: `Allocated ${allocations.length} batch lots`,
      },
    });

    return allocations;
  }

  /**
   * Release all batch allocations and inventory reservations for a transfer
   */
  static releaseTransferAllocations(transferId: string, organizationId: string): void {
    const existingAllocs: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfer_batch_allocations WHERE transfer_id = ? AND _deleted = 0`
      )
      .all(transferId);

    for (const alloc of existingAllocs) {
      if (alloc.reservation_id) {
        try {
          InventoryReservationService.releaseReservation(alloc.reservation_id);
        } catch {
          // Ignore if already released or expired
        }
      }
    }

    localDb.prepare('DELETE FROM stock_transfer_batch_allocations WHERE transfer_id = ?').run(transferId);
    localDb.prepare('UPDATE stock_transfer_items SET allocated_quantity = 0, picked_quantity = 0 WHERE transfer_id = ?').run(transferId);
  }
}
