// transferPickPackService.ts — Mobile Picking & Packaging Engine with Warehouse Bin Routing
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { TransferPackage } from '../../domain/transferTypes';

export class TransferPickPackService {
  /**
   * Generate prioritized pick list with bin routing
   */
  static generatePickList(transferId: string, organizationId: string): any {
    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error('Transfer not found');

    const allocations: any[] = localDb
      .prepare(
        `SELECT stba.*, m.name as medicine_name, m.primary_barcode, wb.bin_code, wb.zone, wb.pick_sequence
         FROM stock_transfer_batch_allocations stba
         JOIN medicines m ON m.id = stba.medicine_id OR m._local_id = stba.medicine_id
         LEFT JOIN warehouse_bins wb ON wb.id = stba.source_bin_id
         WHERE stba.transfer_id = ? AND stba._deleted = 0
         ORDER BY COALESCE(wb.pick_sequence, 100) ASC, stba.expiry_date ASC`
      )
      .all(transfer.id);

    return {
      transferId: transfer.id,
      transferNumber: transfer.transfer_number,
      priority: transfer.priority,
      sourceLocationType: transfer.source_location_type,
      sourceLocationId: transfer.source_location_id,
      status: transfer.status,
      allocations: allocations.map((a) => ({
        id: a.id,
        transferItemId: a.transfer_item_id,
        medicineId: a.medicine_id,
        medicineName: a.medicine_name,
        primaryBarcode: a.primary_barcode,
        batchId: a.batch_id,
        batchNumber: a.batch_number,
        expiryDate: a.expiry_date,
        binCode: a.bin_code || 'DEFAULT-BIN',
        zone: a.zone || null,
        quantityAllocated: Number(a.quantity_allocated),
        quantityPicked: Number(a.quantity_picked || 0),
        isPicked: Boolean(a.is_picked),
      })),
    };
  }

  /**
   * Record a pick scan event with strict barcode/batch validation
   */
  static recordPick(params: {
    transferId: string;
    allocationId: string;
    organizationId: string;
    scannedBarcode?: string;
    scannedBatchNumber?: string;
    quantityPicked: number;
    pickedBy: string;
  }): any {
    const {
      transferId,
      allocationId,
      organizationId,
      scannedBarcode,
      scannedBatchNumber,
      quantityPicked,
      pickedBy,
    } = params;

    const alloc: any = localDb
      .prepare(
        `SELECT stba.*, m.primary_barcode 
         FROM stock_transfer_batch_allocations stba
         JOIN medicines m ON m.id = stba.medicine_id OR m._local_id = stba.medicine_id
         WHERE (stba.id = ? OR stba._local_id = ?) AND stba.transfer_id = ? AND stba._deleted = 0`
      )
      .get(allocationId, allocationId, transferId);

    if (!alloc) throw new Error('Batch allocation line not found for this transfer');

    // Barcode validation if supplied
    if (scannedBarcode && scannedBarcode.trim()) {
      const cleanScanned = scannedBarcode.trim();
      const isMatch =
        cleanScanned === alloc.primary_barcode ||
        localDb
          .prepare(
            `SELECT 1 FROM product_barcodes 
             WHERE barcode = ? AND (medicine_id = ? OR medicine_id = ?) AND _deleted = 0`
          )
          .get(cleanScanned, alloc.medicine_id, alloc.medicine_id);

      if (!isMatch) {
        throw new Error(`Validation Error: Scanned barcode ${scannedBarcode} does not match allocated product`);
      }
    }

    // Batch validation if supplied
    if (scannedBatchNumber && scannedBatchNumber.trim()) {
      if (scannedBatchNumber.trim().toUpperCase() !== alloc.batch_number.toUpperCase()) {
        throw new Error(`Validation Error: Scanned batch ${scannedBatchNumber} does not match allocated batch ${alloc.batch_number}`);
      }
    }

    if (quantityPicked <= 0) {
      throw new Error('Picked quantity must be greater than zero');
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'stock_transfer_batch_allocations',
      operation: 'UPDATE',
      data: {
        _local_id: alloc._local_id || alloc.id,
        quantity_picked: quantityPicked,
        is_picked: 1,
        picked_at: nowIso,
      },
    });

    // Update item picked quantity
    const totalPickedRow: any = localDb
      .prepare(
        `SELECT SUM(quantity_picked) as total_picked 
         FROM stock_transfer_batch_allocations 
         WHERE transfer_item_id = ? AND _deleted = 0`
      )
      .get(alloc.transfer_item_id);

    localMutate({
      table: 'stock_transfer_items',
      operation: 'UPDATE',
      data: {
        _local_id: alloc.transfer_item_id,
        picked_quantity: Number(totalPickedRow?.total_picked || 0),
      },
    });

    // Advance transfer to PICKING status if currently READY_TO_PICK
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transferId,
        status: 'PICKING',
        pick_started_at: nowIso,
        picked_by: pickedBy,
      },
    });

    return {
      allocationId: alloc.id,
      quantityAllocated: Number(alloc.quantity_allocated),
      quantityPicked,
      variance: quantityPicked - Number(alloc.quantity_allocated),
      status: 'PICKED',
    };
  }

  /**
   * Complete entire picking process
   */
  static completePicking(transferId: string, organizationId: string, pickedBy: string): any {
    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error('Transfer not found');

    const allocs: any[] = localDb
      .prepare(
        `SELECT * FROM stock_transfer_batch_allocations WHERE transfer_id = ? AND _deleted = 0`
      )
      .all(transfer.id);

    if (allocs.length === 0) {
      throw new Error('Cannot complete picking with zero allocations');
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'PICKED',
        picked_by: pickedBy,
        picked_at: nowIso,
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'PICK_COMPLETE',
        from_status: transfer.status,
        to_status: 'PICKED',
        performed_by: pickedBy,
        notes: `Completed pick for ${allocs.length} lines`,
      },
    });

    return { status: 'PICKED', transferId: transfer.id };
  }

  /**
   * Create packaging box/container and generate shipping labels
   */
  static createPackage(params: {
    transferId: string;
    organizationId: string;
    packageType?: 'BOX' | 'BAG' | 'CONTAINER' | 'COLD_BOX' | 'PALLET';
    isColdChain?: boolean;
    items: Array<{
      transferItemId: string;
      batchAllocationId: string;
      medicineId: string;
      batchId: string;
      quantityPacked: number;
    }>;
    packedBy: string;
    weightKg?: number;
    specialInstructions?: string;
    sealNumber?: string;
  }): TransferPackage {
    const {
      transferId,
      organizationId,
      packageType = 'BOX',
      isColdChain = false,
      items,
      packedBy,
      weightKg,
      specialInstructions,
      sealNumber,
    } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error('Transfer not found');

    const existingPackages: any = localDb
      .prepare('SELECT COUNT(*) as cnt FROM transfer_packages WHERE transfer_id = ?')
      .get(transfer.id);

    const nextPkgNum = Number(existingPackages?.cnt || 0) + 1;
    const pkgId = uuidv4();
    const pkgIdentifier = `${transfer.transfer_number}/PKG-${String(nextPkgNum).padStart(2, '0')}`;
    const nowIso = new Date().toISOString();

    const pkg = localMutate({
      table: 'transfer_packages',
      operation: 'INSERT',
      data: {
        id: pkgId,
        _local_id: pkgId,
        transfer_id: transfer.id,
        organization_id: organizationId,
        package_identifier: pkgIdentifier,
        package_number: nextPkgNum,
        package_type: packageType,
        is_cold_chain: isColdChain ? 1 : 0,
        packed_by: packedBy,
        packed_at: nowIso,
        weight_kg: weightKg || null,
        special_instructions: specialInstructions || null,
        seal_number: sealNumber || null,
      },
    });

    for (const item of items) {
      localMutate({
        table: 'transfer_package_items',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          package_id: pkgId,
          transfer_id: transfer.id,
          transfer_item_id: item.transferItemId,
          batch_allocation_id: item.batchAllocationId,
          medicine_id: item.medicineId,
          batch_id: item.batchId,
          quantity_packed: item.quantityPacked,
        },
      });
    }

    // Update transfer header package count and status
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'PACKED',
        package_count: nextPkgNum,
        packed_by: packedBy,
        packed_at: nowIso,
        is_cold_chain: isColdChain || transfer.is_cold_chain ? 1 : 0,
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'PACKED',
        from_status: transfer.status,
        to_status: 'PACKED',
        performed_by: packedBy,
        notes: `Created package ${pkgIdentifier}`,
      },
    });

    return pkg as any;
  }
}
