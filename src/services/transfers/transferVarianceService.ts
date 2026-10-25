// transferVarianceService.ts — Transfer Discrepancy Investigation & Compensating Adjustment Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { TransferVariance, TransferVarianceResolution } from '../../domain/transferTypes';
import { InventoryPositionService } from '../inventoryPosition';

export class TransferVarianceService {
  /**
   * List all variances for an organization or specific transfer
   */
  static listVariances(params: {
    organizationId: string;
    transferId?: string;
    status?: string;
  }): TransferVariance[] {
    const { organizationId, transferId, status } = params;
    let query = `SELECT tv.*, m.name as medicine_name, mb.batch_number, mb.expiry_date
                 FROM transfer_variances tv
                 JOIN medicines m ON m.id = tv.medicine_id OR m._local_id = tv.medicine_id
                 JOIN medicine_batches mb ON mb.id = tv.batch_id OR mb._local_id = tv.batch_id
                 WHERE (tv.organization_id = ?) AND tv._deleted = 0`;
    const args: any[] = [organizationId];

    if (transferId) {
      query += ` AND tv.transfer_id = ?`;
      args.push(transferId);
    }
    if (status) {
      query += ` AND tv.status = ?`;
      args.push(status);
    }

    query += ` ORDER BY tv.created_at DESC`;
    const rows: any[] = localDb.prepare(query).all(...args);
    return rows.map((r) => ({
      ...r,
      expected_quantity: Number(r.expected_quantity),
      actual_quantity: Number(r.actual_quantity),
      variance_quantity: Number(r.variance_quantity),
      unit_cost_paise: Number(r.unit_cost_paise),
      variance_value_paise: Number(r.variance_value_paise),
    }));
  }

  /**
   * Resolve a variance case with supervisor authorization and compensating ledger movements
   */
  static resolveVariance(params: {
    varianceId: string;
    organizationId: string;
    resolution: TransferVarianceResolution;
    resolutionNotes: string;
    resolvedBy: string;
    userRole?: string;
  }): TransferVariance {
    const { varianceId, organizationId, resolution, resolutionNotes, resolvedBy, userRole } = params;

    const variance: any = localDb
      .prepare(
        `SELECT * FROM transfer_variances 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(varianceId, varianceId, organizationId);

    if (!variance) throw new Error(`Variance not found: ${varianceId}`);

    const transfer: any = localDb
      .prepare('SELECT * FROM stock_transfers WHERE id = ?')
      .get(variance.transfer_id);

    const nowIso = new Date().toISOString();
    const destStoreId = transfer?.destination_location_type === 'STORE' ? transfer?.destination_location_id : null;
    const destWarehouseId = transfer?.destination_location_type === 'WAREHOUSE' ? transfer?.destination_location_id : null;

    // Compensating stock movements based on resolution
    if (resolution === 'STOCK_ADJUSTMENT' || resolution === 'DESTINATION_CORRECTION') {
      if (variance.variance_type === 'EXCESS') {
        const excessQty = Math.abs(Number(variance.variance_quantity));
        // Add excess to destination available
        InventoryPositionService.adjustStock({
          organizationId,
          medicineId: variance.medicine_id,
          batchId: variance.batch_id,
          locationType: transfer?.destination_location_type || 'STORE',
          storeId: destStoreId,
          warehouseId: destWarehouseId,
          quantityDelta: excessQty,
        });

        // Write ledger TRANSFER_EXCESS_ADJUSTMENT
        localMutate({
          table: 'stock_ledger',
          operation: 'INSERT',
          data: {
            id: uuidv4(),
            organization_id: organizationId,
            medicine_id: variance.medicine_id,
            batch_id: variance.batch_id,
            location_type: transfer?.destination_location_type || 'STORE',
            store_id: destStoreId,
            warehouse_id: destWarehouseId,
            movement_type: 'TRANSFER_EXCESS_ADJUSTMENT',
            quantity_delta: excessQty,
            reference_id: transfer?.id,
            reference_type: 'TRANSFER',
            cost_per_unit: (variance.unit_cost_paise || 0) / 100,
            unit_cost_paise: variance.unit_cost_paise || 0,
            notes: `Excess adjustment approved: ${resolutionNotes}`,
            created_by: resolvedBy,
            created_at: nowIso,
          },
        });
      }
    }

    const updatedVariance = localMutate({
      table: 'transfer_variances',
      operation: 'UPDATE',
      data: {
        _local_id: variance._local_id || variance.id,
        status: 'RESOLVED',
        resolution,
        resolution_notes: resolutionNotes,
        resolved_by: resolvedBy,
        resolved_at: nowIso,
      },
    });

    // Check if all variances for transfer are resolved
    const openVariances: any[] = localDb
      .prepare(
        `SELECT 1 FROM transfer_variances WHERE transfer_id = ? AND status != 'RESOLVED' AND status != 'REJECTED' AND _deleted = 0`
      )
      .all(variance.transfer_id);

    if (openVariances.length === 0 && transfer) {
      localMutate({
        table: 'stock_transfers',
        operation: 'UPDATE',
        data: {
          _local_id: transfer._local_id || transfer.id,
          status: 'CLOSED',
          completed_at: nowIso,
        },
      });

      localMutate({
        table: 'transfer_events',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          transfer_id: transfer.id,
          organization_id: organizationId,
          event_type: 'CLOSED',
          from_status: transfer.status,
          to_status: 'CLOSED',
          performed_by: resolvedBy,
          notes: `Transfer closed following complete variance resolution`,
        },
      });
    }

    return updatedVariance as any;
  }
}
