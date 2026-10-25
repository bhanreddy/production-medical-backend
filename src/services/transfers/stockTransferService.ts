// stockTransferService.ts — Enterprise Stock Transfer Document Lifecycle Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import {
  StockTransfer,
  StockTransferItem,
  TransferType,
  TransferPriority,
  TransferSourceReason,
} from '../../domain/transferTypes';
import { LocationType } from '../../domain/units';
import { DocumentNumberingService } from '../documentNumbering';
import { LocationService } from './locationService';
import { TransferPolicyService } from './transferPolicyService';
import { TransferAllocationService } from './transferAllocationService';

export class StockTransferService {
  /**
   * Create a new Stock Transfer in DRAFT or REQUESTED status
   */
  static createTransfer(params: {
    organizationId: string;
    transferType: TransferType;
    sourceLocationType: LocationType;
    sourceLocationId: string;
    destinationLocationType: LocationType;
    destinationLocationId: string;
    priority?: TransferPriority;
    reason?: TransferSourceReason;
    requestedBy: string;
    requiredByDate?: string;
    stockStateTransferred?: 'AVAILABLE' | 'QUARANTINED' | 'RECALLED' | 'DAMAGED';
    notes?: string;
    idempotencyKey?: string;
    items: Array<{
      medicineId: string;
      requestedUnit?: string;
      conversionFactor?: number;
      requestedQuantity: number;
      notes?: string;
    }>;
  }): StockTransfer {
    const {
      organizationId,
      transferType,
      sourceLocationType,
      sourceLocationId,
      destinationLocationType,
      destinationLocationId,
      priority = 'NORMAL',
      reason = 'MANUAL',
      requestedBy,
      requiredByDate,
      stockStateTransferred = 'AVAILABLE',
      notes,
      idempotencyKey,
      items,
    } = params;

    // Organization validation & Isolation
    const sourceLoc = LocationService.resolveLocation(sourceLocationType, sourceLocationId, organizationId);
    const destLoc = LocationService.resolveLocation(destinationLocationType, destinationLocationId, organizationId);

    if (sourceLoc.organizationId !== destLoc.organizationId && organizationId !== 'default-org') {
      throw new Error(`Cross-organization transfer blocked between ${sourceLoc.organizationId} and ${destLoc.organizationId}`);
    }

    if (sourceLocationType === destinationLocationType && sourceLocationId === destinationLocationId) {
      throw new Error('Source location and destination location cannot be identical');
    }

    if (items.length === 0) {
      throw new Error('Transfer must include at least one medicine item');
    }

    // Idempotency protection
    if (idempotencyKey) {
      const existing: any = localDb
        .prepare('SELECT * FROM stock_transfers WHERE idempotency_key = ? AND _deleted = 0')
        .get(idempotencyKey);
      if (existing) {
        return this.getTransferById(existing.id, organizationId)!;
      }
    }

    const transferId = uuidv4();
    const nowIso = new Date().toISOString();
    const customPrefix = `${sourceLoc.code || 'SRC'}/${destLoc.code || 'DST'}/TRF`;
    const transferNumber = DocumentNumberingService.generate({
      organizationId,
      storeId: sourceLocationType === 'STORE' ? sourceLocationId : null,
      documentType: 'TRANSFER',
      customPrefix,
    });

    let totalQuantity = 0;
    let totalEstimatedValuePaise = 0;

    const transfer = localMutate({
      table: 'stock_transfers',
      operation: 'INSERT',
      data: {
        id: transferId,
        _local_id: transferId,
        organization_id: organizationId,
        transfer_number: transferNumber,
        transfer_type: transferType,
        source_location_type: sourceLocationType,
        source_location_id: sourceLocationId,
        destination_location_type: destinationLocationType,
        destination_location_id: destinationLocationId,
        source_name: sourceLoc.name,
        destination_name: destLoc.name,
        priority,
        reason,
        status: 'REQUESTED',
        stock_state_transferred: stockStateTransferred,
        total_items: items.length,
        total_quantity_requested: 0,
        total_value_paise: 0,
        requested_by: requestedBy,
        requested_at: nowIso,
        required_by_date: requiredByDate || null,
        notes: notes || null,
        idempotency_key: idempotencyKey || null,
      },
    });

    for (const item of items) {
      const med: any = localDb
        .prepare('SELECT * FROM medicines WHERE id = ? OR _local_id = ?')
        .get(item.medicineId, item.medicineId);

      const convFactor = item.conversionFactor || 1.0;
      const baseQty = item.requestedQuantity * convFactor;
      const unitCost = Math.round(Number(med?.purchase_price || 0) * 100);
      const lineValue = Math.round(baseQty * unitCost);

      totalQuantity += baseQty;
      totalEstimatedValuePaise += lineValue;

      const itemId = uuidv4();
      localMutate({
        table: 'stock_transfer_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          transfer_id: transferId,
          organization_id: organizationId,
          medicine_id: item.medicineId,
          medicine_name: med?.name || 'Unknown Item',
          requested_unit: item.requestedUnit || 'strip',
          conversion_factor: convFactor,
          requested_quantity: item.requestedQuantity,
          base_quantity_requested: baseQty,
          unit_cost_paise: unitCost,
          total_value_paise: lineValue,
          notes: item.notes || null,
        },
      });
    }

    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transferId,
        total_quantity_requested: totalQuantity,
        total_value_paise: totalEstimatedValuePaise,
      },
    });

    // Write audit event
    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transferId,
        organization_id: organizationId,
        event_type: 'REQUESTED',
        from_status: 'DRAFT',
        to_status: 'REQUESTED',
        performed_by: requestedBy,
        notes: `Created transfer request for ${items.length} SKUs`,
      },
    });

    // Check policy auto-approval
    const policyRole = TransferPolicyService.getRequiredApprovalRole(
      organizationId,
      totalEstimatedValuePaise,
      transferType
    );
    if (policyRole === 'AUTO') {
      return this.approveTransfer({
        transferId,
        organizationId,
        approvedBy: 'SYSTEM_AUTO',
        userRole: 'SYSTEM',
      });
    }

    return this.getTransferById(transferId, organizationId)!;
  }

  /**
   * Approve a transfer request
   */
  static approveTransfer(params: {
    transferId: string;
    organizationId: string;
    approvedBy: string;
    userRole?: string;
  }): StockTransfer {
    const { transferId, organizationId, approvedBy, userRole } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error(`Transfer not found: ${transferId}`);

    if (transfer.status !== 'REQUESTED' && transfer.status !== 'PENDING_APPROVAL') {
      throw new Error(`Cannot approve transfer in status: ${transfer.status}`);
    }

    const policy = TransferPolicyService.getPolicy(organizationId);

    // Maker-checker validation
    if (policy.enforceMakerChecker && transfer.requested_by === approvedBy && approvedBy !== 'SYSTEM_AUTO') {
      throw new Error('Maker-Checker Violation: Transfer creator cannot approve their own transfer');
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'APPROVED',
        approved_by: approvedBy,
        approved_at: nowIso,
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'APPROVED',
        from_status: transfer.status,
        to_status: 'APPROVED',
        performed_by: approvedBy,
        notes: `Transfer approved by ${approvedBy}`,
      },
    });

    // Auto-allocate batches upon approval if FEFO is configured
    if (policy.requireFefoAllocation) {
      try {
        TransferAllocationService.allocateTransfer({
          transferId: transfer.id,
          organizationId,
          allocatedBy: approvedBy,
        });
      } catch (err: any) {
        // If insufficient stock, keep in APPROVED status for manual allocation
      }
    }

    return this.getTransferById(transfer.id, organizationId)!;
  }

  /**
   * Reject a transfer request
   */
  static rejectTransfer(params: {
    transferId: string;
    organizationId: string;
    rejectedBy: string;
    rejectionReason: string;
  }): StockTransfer {
    const { transferId, organizationId, rejectedBy, rejectionReason } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error(`Transfer not found: ${transferId}`);

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'REJECTED',
        rejected_by: rejectedBy,
        rejected_at: nowIso,
        rejection_reason: rejectionReason,
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'REJECTED',
        from_status: transfer.status,
        to_status: 'REJECTED',
        performed_by: rejectedBy,
        notes: `Rejected: ${rejectionReason}`,
      },
    });

    return this.getTransferById(transfer.id, organizationId)!;
  }

  /**
   * Cancel a transfer with stage-aware reservation release
   */
  static cancelTransfer(params: {
    transferId: string;
    organizationId: string;
    cancelledBy: string;
    cancellationReason?: string;
  }): StockTransfer {
    const { transferId, organizationId, cancelledBy, cancellationReason } = params;

    const transfer: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(transferId, transferId, organizationId);

    if (!transfer) throw new Error(`Transfer not found: ${transferId}`);

    if (transfer.status === 'DISPATCHED' || transfer.status === 'IN_TRANSIT' || transfer.status === 'RECEIVED' || transfer.status === 'CLOSED') {
      throw new Error(`Cannot directly cancel transfer in ${transfer.status} status. Please use Return to Source transfer workflow.`);
    }

    // Release reservations and batch allocations if allocated or picked
    TransferAllocationService.releaseTransferAllocations(transfer.id, organizationId);

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'stock_transfers',
      operation: 'UPDATE',
      data: {
        _local_id: transfer._local_id || transfer.id,
        status: 'CANCELLED',
        cancelled_by: cancelledBy,
        cancelled_at: nowIso,
        cancellation_reason: cancellationReason || 'Cancelled by user',
      },
    });

    localMutate({
      table: 'transfer_events',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        transfer_id: transfer.id,
        organization_id: organizationId,
        event_type: 'CANCELLED',
        from_status: transfer.status,
        to_status: 'CANCELLED',
        performed_by: cancelledBy,
        notes: `Cancelled: ${cancellationReason || 'User cancellation'}`,
      },
    });

    return this.getTransferById(transfer.id, organizationId)!;
  }

  /**
   * Create an explicit Return Transfer if destination rejects shipment
   */
  static createReturnTransfer(params: {
    originalTransferId: string;
    organizationId: string;
    reason: string;
    returnedBy: string;
    lines?: Array<{ medicineId: string; batchId: string; quantity: number }>;
  }): StockTransfer {
    const { originalTransferId, organizationId, reason, returnedBy, lines } = params;

    const orig: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers WHERE (id = ? OR _local_id = ?) AND (organization_id = ?)`
      )
      .get(originalTransferId, originalTransferId, organizationId);

    if (!orig) throw new Error(`Original transfer not found: ${originalTransferId}`);

    // Return flips source and destination
    return this.createTransfer({
      organizationId,
      transferType: 'RETURN_TO_SOURCE',
      sourceLocationType: orig.destination_location_type,
      sourceLocationId: orig.destination_location_id,
      destinationLocationType: orig.source_location_type,
      destinationLocationId: orig.source_location_id,
      priority: 'HIGH',
      reason: 'MANUAL',
      requestedBy: returnedBy,
      notes: `Return against ${orig.transfer_number}. Reason: ${reason}`,
      items: lines
        ? lines.map((l) => ({
            medicineId: l.medicineId,
            requestedQuantity: l.quantity,
          }))
        : localDb
            .prepare('SELECT medicine_id, requested_quantity FROM stock_transfer_items WHERE transfer_id = ?')
            .all(orig.id)
            .map((i: any) => ({
              medicineId: i.medicine_id,
              requestedQuantity: Number(i.requested_quantity),
            })),
    });
  }

  /**
   * Get single transfer by ID with all populated details
   */
  static getTransferById(id: string, organizationId: string): StockTransfer | null {
    const row: any = localDb
      .prepare(
        `SELECT * FROM stock_transfers 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const items: any[] = localDb
      .prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ? AND _deleted = 0')
      .all(row.id);

    const allocations: any[] = localDb
      .prepare('SELECT * FROM stock_transfer_batch_allocations WHERE transfer_id = ? AND _deleted = 0')
      .all(row.id);

    const packages: any[] = localDb
      .prepare('SELECT * FROM transfer_packages WHERE transfer_id = ? AND _deleted = 0')
      .all(row.id);

    const receipts: any[] = localDb
      .prepare('SELECT * FROM transfer_receipts WHERE transfer_id = ? AND _deleted = 0')
      .all(row.id);

    const variances: any[] = localDb
      .prepare('SELECT * FROM transfer_variances WHERE transfer_id = ? AND _deleted = 0')
      .all(row.id);

    const events: any[] = localDb
      .prepare('SELECT * FROM transfer_events WHERE transfer_id = ? ORDER BY created_at ASC')
      .all(row.id);

    return {
      ...row,
      total_items: Number(row.total_items || 0),
      total_quantity_requested: Number(row.total_quantity_requested || 0),
      total_quantity_dispatched: Number(row.total_quantity_dispatched || 0),
      total_quantity_received: Number(row.total_quantity_received || 0),
      total_value_paise: Number(row.total_value_paise || 0),
      package_count: Number(row.package_count || 0),
      is_cold_chain: Boolean(row.is_cold_chain),
      items: items.map((i) => ({
        ...i,
        conversion_factor: Number(i.conversion_factor || 1),
        requested_quantity: Number(i.requested_quantity || 0),
        base_quantity_requested: Number(i.base_quantity_requested || 0),
        allocated_quantity: Number(i.allocated_quantity || 0),
        picked_quantity: Number(i.picked_quantity || 0),
        dispatched_quantity: Number(i.dispatched_quantity || 0),
        received_quantity: Number(i.received_quantity || 0),
        damaged_quantity: Number(i.damaged_quantity || 0),
        short_quantity: Number(i.short_quantity || 0),
        excess_quantity: Number(i.excess_quantity || 0),
        rejected_quantity: Number(i.rejected_quantity || 0),
        unit_cost_paise: Number(i.unit_cost_paise || 0),
        total_value_paise: Number(i.total_value_paise || 0),
      })),
      allocations: allocations.map((a) => ({
        ...a,
        quantity_allocated: Number(a.quantity_allocated || 0),
        quantity_picked: Number(a.quantity_picked || 0),
        quantity_dispatched: Number(a.quantity_dispatched || 0),
        quantity_received: Number(a.quantity_received || 0),
        quantity_damaged: Number(a.quantity_damaged || 0),
        quantity_short: Number(a.quantity_short || 0),
        quantity_excess: Number(a.quantity_excess || 0),
        unit_cost_paise: Number(a.unit_cost_paise || 0),
        mrp_paise: Number(a.mrp_paise || 0),
        is_picked: Boolean(a.is_picked),
      })),
      packages: packages.map((p) => ({
        ...p,
        is_cold_chain: Boolean(p.is_cold_chain),
        package_number: Number(p.package_number || 1),
      })),
      receipts,
      variances: variances.map((v) => ({
        ...v,
        expected_quantity: Number(v.expected_quantity),
        actual_quantity: Number(v.actual_quantity),
        variance_quantity: Number(v.variance_quantity),
        unit_cost_paise: Number(v.unit_cost_paise),
        variance_value_paise: Number(v.variance_value_paise),
      })),
      events,
    };
  }

  /**
   * List paginated transfers with filters
   */
  static listTransfers(params: {
    organizationId: string;
    status?: string;
    transferType?: string;
    priority?: string;
    sourceLocationId?: string;
    destinationLocationId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): { data: StockTransfer[]; total: number } {
    const {
      organizationId,
      status,
      transferType,
      priority,
      sourceLocationId,
      destinationLocationId,
      search,
      page = 1,
      limit = 50,
    } = params;

    let whereClause = `WHERE (organization_id = ?) AND _deleted = 0`;
    const args: any[] = [organizationId];

    if (status) {
      whereClause += ` AND status = ?`;
      args.push(status);
    }
    if (transferType) {
      whereClause += ` AND transfer_type = ?`;
      args.push(transferType);
    }
    if (priority) {
      whereClause += ` AND priority = ?`;
      args.push(priority);
    }
    if (sourceLocationId) {
      whereClause += ` AND (source_location_id = ? OR source_location_id = ?)`;
      args.push(sourceLocationId, sourceLocationId);
    }
    if (destinationLocationId) {
      whereClause += ` AND (destination_location_id = ? OR destination_location_id = ?)`;
      args.push(destinationLocationId, destinationLocationId);
    }
    if (search && search.trim()) {
      whereClause += ` AND (transfer_number LIKE ? OR source_name LIKE ? OR destination_name LIKE ?)`;
      const term = `%${search.trim()}%`;
      args.push(term, term, term);
    }

    const countRow: any = localDb
      .prepare(`SELECT COUNT(*) as total FROM stock_transfers ${whereClause}`)
      .get(...args);

    const offset = (page - 1) * limit;
    const rows: any[] = localDb
      .prepare(`SELECT * FROM stock_transfers ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);

    return {
      data: rows.map((r) => this.getTransferById(r.id, organizationId)!),
      total: Number(countRow?.total || 0),
    };
  }
}
