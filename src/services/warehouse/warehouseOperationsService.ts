// warehouseOperationsService.ts — Warehouse Bins, Pick Sequencing & Operational Queues Engine
import { AppError } from '../../lib/appError';
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { WarehouseBin } from '../../domain/transferTypes';

export class WarehouseOperationsService {
  /**
   * List all bins for a warehouse
   */
  static listBins(organizationId: string, warehouseId: string): WarehouseBin[] {
    const rows: any[] = localDb
      .prepare(
        `SELECT * FROM warehouse_bins
         WHERE (organization_id = ?)
           AND (warehouse_id = ? OR warehouse_id = ?)
           AND _deleted = 0
         ORDER BY pick_sequence ASC, bin_code ASC`
      )
      .all(organizationId, warehouseId, warehouseId);

    return rows.map((r) => ({
      ...r,
      pick_sequence: Number(r.pick_sequence || 100),
      is_active: Boolean(r.is_active),
    }));
  }

  /**
   * Create or configure a warehouse bin
   */
  static createBin(params: {
    organizationId: string;
    warehouseId: string;
    binCode: string;
    binName: string;
    zone?: string;
    rack?: string;
    shelf?: string;
    binType?: 'STORAGE' | 'STAGING' | 'PICKING' | 'PACKING' | 'COLD_ROOM' | 'QUARANTINE' | 'RECALL' | 'DAMAGE';
    pickSequence?: number;
  }): WarehouseBin {
    const {
      organizationId,
      warehouseId,
      binCode,
      binName,
      zone,
      rack,
      shelf,
      binType = 'STORAGE',
      pickSequence = 100,
    } = params;

    const binId = uuidv4();
    const nowIso = new Date().toISOString();

    const bin = localMutate({
      table: 'warehouse_bins',
      operation: 'INSERT',
      data: {
        id: binId,
        _local_id: binId,
        organization_id: organizationId,
        warehouse_id: warehouseId,
        bin_code: binCode.trim().toUpperCase(),
        bin_name: binName.trim(),
        zone: zone ? zone.trim().toUpperCase() : null,
        rack: rack ? rack.trim().toUpperCase() : null,
        shelf: shelf ? shelf.trim().toUpperCase() : null,
        bin_type: binType,
        pick_sequence: pickSequence,
        is_active: 1,
        created_at: nowIso,
        updated_at: nowIso,
      },
    });

    return bin as any;
  }

  /**
   * Aggregate operational summary for a warehouse
   */
  static getWarehouseDashboard(organizationId: string, warehouseId: string): any {
    const wh: any = localDb
      .prepare(
        `SELECT * FROM warehouses WHERE (id = ? OR _local_id = ?) AND (organization_id = ?)`
      )
      .get(warehouseId, warehouseId, organizationId);

    if (!wh) throw new AppError(404, 'Warehouse not found');

    // Inbound Transfers
    const inboundTransfers: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfers
         WHERE (destination_location_id = ? OR destination_location_id = ?)
           AND status IN ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED')
           AND _deleted = 0`
      )
      .all(wh.id, wh.id);

    // Pick Queue
    const pickQueue: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfers
         WHERE (source_location_id = ? OR source_location_id = ?)
           AND status IN ('READY_TO_PICK', 'PICKING')
           AND _deleted = 0
         ORDER BY CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'HIGH' THEN 3 ELSE 4 END`
      )
      .all(wh.id, wh.id);

    // Pack Queue
    const packQueue: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfers
         WHERE (source_location_id = ? OR source_location_id = ?)
           AND status = 'PICKED'
           AND _deleted = 0`
      )
      .all(wh.id, wh.id);

    // Dispatch Queue
    const dispatchQueue: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfers
         WHERE (source_location_id = ? OR source_location_id = ?)
           AND status = 'PACKED'
           AND _deleted = 0`
      )
      .all(wh.id, wh.id);

    // In-Transit Transfers
    const inTransitTransfers: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfers
         WHERE (source_location_id = ? OR source_location_id = ? OR destination_location_id = ? OR destination_location_id = ?)
           AND status IN ('DISPATCHED', 'IN_TRANSIT')
           AND _deleted = 0`
      )
      .all(wh.id, wh.id, wh.id, wh.id);

    // Quarantine & Recalled Stock
    const quarantineSummary: any = localDb
      .prepare(
        `SELECT COALESCE(SUM(quantity_quarantined), 0) as total_quarantined,
                COALESCE(SUM(quantity_recalled), 0) as total_recalled,
                COALESCE(SUM(quantity_damaged), 0) as total_damaged
         FROM inventory_positions
         WHERE (warehouse_id = ? OR warehouse_id = ?) AND location_type = 'WAREHOUSE'`
      )
      .get(wh.id, wh.id);

    return {
      warehouseId: wh.id,
      warehouseCode: wh.warehouse_code,
      warehouseName: wh.name,
      inboundQueueCount: inboundTransfers.length,
      pickQueueCount: pickQueue.length,
      packQueueCount: packQueue.length,
      dispatchQueueCount: dispatchQueue.length,
      inTransitCount: inTransitTransfers.length,
      quarantineUnits: Number(quarantineSummary?.total_quarantined || 0),
      recalledUnits: Number(quarantineSummary?.total_recalled || 0),
      damagedUnits: Number(quarantineSummary?.total_damaged || 0),
      pickQueue,
      packQueue,
      dispatchQueue,
      inboundTransfers,
    };
  }
}
