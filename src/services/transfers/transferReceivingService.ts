// transferReceivingService.ts — Transfer Receiving, Partial Inward & Discrepancy Capture Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { StockTransfer, TransferReceipt } from '../../domain/transferTypes';
import { InventoryPositionService } from '../inventoryPosition';
import { LocationService } from './locationService';

export class TransferReceivingService {
  /**
   * Authoritative Destination Receipt:
   * 1. Validates receiver access to destination location
   * 2. Decrements in_transit quantity
   * 3. Increments destination inventory position (sound -> available, damaged -> damaged)
   * 4. Preserves recalled/quarantined state if transferred as such
   * 5. Writes immutable stock_ledger entry: TRANSFER_IN
   * 6. Records variances in transfer_variances table
   * 7. Updates transfer status to RECEIVED or PARTIALLY_RECEIVED or VARIANCE_REVIEW
   */
  static receiveTransfer(params: {
    transferId: string;
    organizationId: string;
    receivedBy: string;
    conditionStatus?: 'GOOD' | 'DAMAGED_PACKAGING' | 'TEMPERATURE_BREACH' | 'TAMPERED';
    items: Array<{
      transferItemId: string;
      batchAllocationId: string;
      medicineId: string;
      batchId: string;
      quantityAccepted: number;
      quantityDamaged?: number;
      quantityShort?: number;
      quantityExcess?: number;
      quantityRejected?: number;
      destinationBinId?: string;
      damageNotes?: string;
    }>;
    idempotencyKey?: string;
    notes?: string;
  }): { transfer: StockTransfer; receipt: TransferReceipt } {
    const {
      transferId,
      organizationId,
      receivedBy,
      conditionStatus = 'GOOD',
      items,
      idempotencyKey,
      notes,
    } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error(`Stock transfer not found: ${transferId}`);

    // Validate receiver access to destination location
    const hasDestAccess = LocationService.validateUserAccess(
      receivedBy,
      transfer.destination_location_type,
      transfer.destination_location_id,
      organizationId
    );
    if (!hasDestAccess) {
      throw new Error(`Security Violation: User ${receivedBy} is not authorized to receive stock at destination ${transfer.destination_location_id}`);
    }

    if (
      transfer.status !== 'DISPATCHED' &&
      transfer.status !== 'IN_TRANSIT' &&
      transfer.status !== 'PARTIALLY_RECEIVED'
    ) {
      throw new Error(`Cannot receive transfer in status: ${transfer.status}`);
    }

    // Check duplicate receipt idempotency
    if (idempotencyKey) {
      const existingReceipt: any = localDb
        .prepare('SELECT * FROM transfer_receipts WHERE idempotency_key = ? AND _deleted = 0')
        .get(idempotencyKey);
      if (existingReceipt) {
        return { transfer, receipt: existingReceipt };
      }
    }

    const nowIso = new Date().toISOString();
    const receiptId = uuidv4();
    const existingReceiptCount: any = localDb
      .prepare('SELECT COUNT(*) as cnt FROM transfer_receipts WHERE transfer_id = ?')
      .get(transfer.id);
    const receiptNum = `${transfer.transfer_number}/REC-${String((existingReceiptCount?.cnt || 0) + 1).padStart(2, '0')}`;

    const receipt = localMutate({
      table: 'transfer_receipts',
      operation: 'INSERT',
      data: {
        id: receiptId,
        _local_id: receiptId,
        transfer_id: transfer.id,
        organization_id: organizationId,
        receipt_number: receiptNum,
        received_by: receivedBy,
        received_at: nowIso,
        status: 'COMPLETED',
        condition_status: conditionStatus,
        idempotency_key: idempotencyKey || null,
        notes: notes || null,
      },
    });

    const sourceStoreId = transfer.source_location_type === 'STORE' ? transfer.source_location_id : null;
    const sourceWarehouseId = transfer.source_location_type === 'WAREHOUSE' ? transfer.source_location_id : null;
    const destStoreId = transfer.destination_location_type === 'STORE' ? transfer.destination_location_id : null;
    const destWarehouseId = transfer.destination_location_type === 'WAREHOUSE' ? transfer.destination_location_id : null;

    let hasVariance = false;
    let totalAcceptedThisReceipt = 0;
    let totalDamagedThisReceipt = 0;

    const isRecalled = transfer.stock_state_transferred === 'RECALLED';
    const isQuarantined = transfer.stock_state_transferred === 'QUARANTINED';

    for (const item of items) {
      const alloc: any = localDb
        .prepare(
          `SELECT * FROM stock_transfer_batch_allocations WHERE id = ? OR _local_id = ?`
        )
        .get(item.batchAllocationId, item.batchAllocationId);

      const dispatchedQty = alloc ? Number(alloc.quantity_dispatched || alloc.quantity_picked || alloc.quantity_allocated) : 0;
      const acceptedQty = Number(item.quantityAccepted || 0);
      const damagedQty = Number(item.quantityDamaged || 0);
      const shortQty = Number(item.quantityShort || 0);
      const excessQty = Number(item.quantityExcess || 0);
      const rejectedQty = Number(item.quantityRejected || 0);

      // Record receipt item line
      localMutate({
        table: 'transfer_receipt_items',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          receipt_id: receiptId,
          transfer_id: transfer.id,
          transfer_item_id: item.transferItemId,
          batch_allocation_id: item.batchAllocationId,
          medicine_id: item.medicineId,
          batch_id: item.batchId,
          quantity_dispatched: dispatchedQty,
          quantity_accepted: acceptedQty,
          quantity_damaged: damagedQty,
          quantity_short: shortQty,
          quantity_excess: excessQty,
          quantity_rejected: rejectedQty,
          destination_bin_id: item.destinationBinId || null,
          damage_notes: item.damageNotes || null,
        },
      });

      // 1. Decrement in-transit position at source
      const transitClearQty = acceptedQty + damagedQty + shortQty;
      if (transitClearQty > 0) {
        InventoryPositionService.updateStateQuantities({
          organizationId,
          medicineId: item.medicineId,
          batchId: item.batchId,
          locationType: transfer.source_location_type,
          storeId: sourceStoreId,
          warehouseId: sourceWarehouseId,
          inTransitDelta: -transitClearQty,
        });
      }

      // 2. Increment destination inventory positions
      const destPhysicalInward = acceptedQty + damagedQty;
      if (destPhysicalInward > 0) {
        InventoryPositionService.adjustStock({
          organizationId,
          medicineId: item.medicineId,
          batchId: item.batchId,
          locationType: transfer.destination_location_type,
          storeId: destStoreId,
          warehouseId: destWarehouseId,
          quantityDelta: destPhysicalInward,
        });

        // Sub-state segregation:
        if (isRecalled) {
          // Preserve recalled state at destination
          InventoryPositionService.updateStateQuantities({
            organizationId,
            medicineId: item.medicineId,
            batchId: item.batchId,
            locationType: transfer.destination_location_type,
            storeId: destStoreId,
            warehouseId: destWarehouseId,
            recalledDelta: destPhysicalInward,
          });
        } else if (isQuarantined) {
          // Preserve quarantined state at destination
          InventoryPositionService.updateStateQuantities({
            organizationId,
            medicineId: item.medicineId,
            batchId: item.batchId,
            locationType: transfer.destination_location_type,
            storeId: destStoreId,
            warehouseId: destWarehouseId,
            quarantinedDelta: destPhysicalInward,
          });
        } else {
          // Normal transfer: damaged units quarantined
          if (damagedQty > 0) {
            InventoryPositionService.updateStateQuantities({
              organizationId,
              medicineId: item.medicineId,
              batchId: item.batchId,
              locationType: transfer.destination_location_type,
              storeId: destStoreId,
              warehouseId: destWarehouseId,
              damagedDelta: damagedQty,
            });
          }
        }
      }

      // 3. Write immutable stock ledger entry at destination: TRANSFER_IN
      if (destPhysicalInward > 0) {
        const ledgerId = uuidv4();
        localMutate({
          table: 'stock_ledger',
          operation: 'INSERT',
          data: {
            id: ledgerId,
            _local_id: ledgerId,
            organization_id: organizationId,
            medicine_id: item.medicineId,
            batch_id: item.batchId,
            location_type: transfer.destination_location_type,
            store_id: destStoreId,
            warehouse_id: destWarehouseId,
            movement_type: 'TRANSFER_IN',
            quantity_delta: destPhysicalInward,
            reference_id: transfer.id,
            reference_type: 'TRANSFER',
            cost_per_unit: (alloc?.unit_cost_paise || 0) / 100,
            unit_cost_paise: alloc?.unit_cost_paise || 0,
            notes: `Transfer In from ${transfer.source_name || transfer.source_location_id} (Ref: ${transfer.transfer_number})`,
            created_by: receivedBy,
            created_at: nowIso,
          },
        });
      }

      // 4. Record variances if damaged, short, or excess
      const unitCost = alloc?.unit_cost_paise || 0;

      if (shortQty > 0) {
        hasVariance = true;
        const varId = uuidv4();
        localMutate({
          table: 'transfer_variances',
          operation: 'INSERT',
          data: {
            id: varId,
            _local_id: varId,
            transfer_id: transfer.id,
            receipt_id: receiptId,
            organization_id: organizationId,
            medicine_id: item.medicineId,
            batch_id: item.batchId,
            variance_type: 'SHORT',
            expected_quantity: dispatchedQty,
            actual_quantity: acceptedQty + damagedQty,
            variance_quantity: -shortQty,
            unit_cost_paise: unitCost,
            variance_value_paise: shortQty * unitCost,
            status: 'REPORTED',
            reported_by: receivedBy,
            reported_at: nowIso,
          },
        });

        // Write ledger loss/shortage trace
        localMutate({
          table: 'stock_ledger',
          operation: 'INSERT',
          data: {
            id: uuidv4(),
            organization_id: organizationId,
            medicine_id: item.medicineId,
            batch_id: item.batchId,
            location_type: transfer.destination_location_type,
            store_id: destStoreId,
            warehouse_id: destWarehouseId,
            movement_type: 'TRANSFER_SHORTAGE',
            quantity_delta: 0, // Recorded as variance trace
            reference_id: transfer.id,
            reference_type: 'TRANSFER',
            cost_per_unit: unitCost / 100,
            unit_cost_paise: unitCost,
            notes: `In-Transit Shortage of ${shortQty} units on ${transfer.transfer_number}`,
            created_by: receivedBy,
            created_at: nowIso,
          },
        });
      }

      if (damagedQty > 0) {
        hasVariance = true;
        const varId = uuidv4();
        localMutate({
          table: 'transfer_variances',
          operation: 'INSERT',
          data: {
            id: varId,
            _local_id: varId,
            transfer_id: transfer.id,
            receipt_id: receiptId,
            organization_id: organizationId,
            medicine_id: item.medicineId,
            batch_id: item.batchId,
            variance_type: 'DAMAGED',
            expected_quantity: dispatchedQty,
            actual_quantity: acceptedQty,
            variance_quantity: damagedQty,
            unit_cost_paise: unitCost,
            variance_value_paise: damagedQty * unitCost,
            status: 'REPORTED',
            reported_by: receivedBy,
            reported_at: nowIso,
          },
        });
      }

      if (excessQty > 0) {
        hasVariance = true;
        const varId = uuidv4();
        localMutate({
          table: 'transfer_variances',
          operation: 'INSERT',
          data: {
            id: varId,
            _local_id: varId,
            transfer_id: transfer.id,
            receipt_id: receiptId,
            organization_id: organizationId,
            medicine_id: item.medicineId,
            batch_id: item.batchId,
            variance_type: 'EXCESS',
            expected_quantity: dispatchedQty,
            actual_quantity: acceptedQty + excessQty,
            variance_quantity: excessQty,
            unit_cost_paise: unitCost,
            variance_value_paise: excessQty * unitCost,
            status: 'REPORTED',
            reported_by: receivedBy,
            reported_at: nowIso,
          },
        });
      }

      // Update allocation received, damaged, short counters
      if (alloc) {
        localMutate({
          table: 'stock_transfer_batch_allocations',
          operation: 'UPDATE',
          data: {
            _local_id: alloc._local_id || alloc.id,
            quantity_received: Number(alloc.quantity_received || 0) + acceptedQty,
            quantity_damaged: Number(alloc.quantity_damaged || 0) + damagedQty,
            quantity_short: Number(alloc.quantity_short || 0) + shortQty,
            quantity_excess: Number(alloc.quantity_excess || 0) + excessQty,
          },
        });
      }

      totalAcceptedThisReceipt += acceptedQty;
      totalDamagedThisReceipt += damagedQty;
    }

    // Update transfer items total received
    const allReceiptItems: any[] = localDb
      .prepare(
        `SELECT transfer_item_id, SUM(quantity_accepted) as acc, SUM(quantity_damaged) as dam, SUM(quantity_short) as sho
         FROM transfer_receipt_items
         WHERE transfer_id = ?
         GROUP BY transfer_item_id`
      )
      .all(transfer.id);

    for (const ri of allReceiptItems) {
      localMutate({
        table: 'stock_transfer_items',
        operation: 'UPDATE',
        data: {
          _local_id: ri.transfer_item_id,
          received_quantity: Number(ri.acc || 0),
          damaged_quantity: Number(ri.dam || 0),
          short_quantity: Number(ri.sho || 0),
        },
      });
    }

    // Compute cumulative total received vs total dispatched
    const totalDispatched = Number(transfer.total_quantity_dispatched || transfer.total_quantity_requested);
    const cumulativeReceived = Number(transfer.total_quantity_received || 0) + totalAcceptedThisReceipt + totalDamagedThisReceipt;

    let nextStatus = 'RECEIVED';
    if (hasVariance) {
      nextStatus = 'VARIANCE_REVIEW';
    } else if (cumulativeReceived < totalDispatched) {
      nextStatus = 'PARTIALLY_RECEIVED';
    }

    const updatedTransfer = localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: nextStatus,
        total_quantity_received: cumulativeReceived,
        received_by: receivedBy,
        received_at: nowIso,
        completed_at: nextStatus === 'RECEIVED' ? nowIso : null,
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: nextStatus === 'PARTIALLY_RECEIVED' ? 'PARTIAL_RECEIPT' : 'RECEIVED',
        from_status: transfer.status,
        to_status: nextStatus,
        performed_by: receivedBy,
        notes: `Received ${totalAcceptedThisReceipt} accepted, ${totalDamagedThisReceipt} damaged. Status: ${nextStatus}`,
      },
    });

    return { transfer: updatedTransfer as any, receipt: receipt as any };
  }
}
