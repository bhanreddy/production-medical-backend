// orderPickPackService.ts — Store Pick & Pack Operations Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { OrderStateMachine } from './orderStateMachine';
import { OrderEventService } from './orderEventService';
import { OrderPackage } from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export interface PickQueueItem {
  orderId: string;
  orderNumber: string;
  fulfilmentId: string;
  customerName: string;
  fulfilmentType: string;
  status: string;
  priority: string;
  prescriptionStatus: string;
  totalItems: number;
  totalQuantity: number;
  placedAt: string;
  isColdChain: boolean;
}

export class OrderPickPackService {
  /**
   * Get store picking queue prioritized by urgency, SLA, and prescription ready state
   */
  static getStorePickQueue(params: {
    organizationId: string;
    storeId: string;
  }): PickQueueItem[] {
    const { organizationId, storeId } = params;

    const rows: any[] = localDb
      .prepare(
        `SELECT o.id as order_id, o.order_number, of.id as fulfilment_id, c.name as customer_name,
                o.fulfilment_type, o.status, o.priority, o.prescription_status, o.placed_at,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND _deleted = 0) as total_items,
                (SELECT SUM(requested_quantity) FROM order_items WHERE order_id = o.id AND _deleted = 0) as total_quantity,
                EXISTS(SELECT 1 FROM order_items oi JOIN medicines m ON (oi.medicine_id = m.id OR oi.medicine_id = m._local_id) WHERE oi.order_id = o.id AND m.cold_chain_required = 1) as is_cold_chain
         FROM orders o
         JOIN order_fulfilments of ON (o.id = of.order_id)
         JOIN customers c ON (o.customer_id = c.id OR o.customer_id = c._local_id)
         WHERE o.organization_id = ? AND of.store_id = ? 
           AND o.status IN ('CONFIRMED', 'INVENTORY_RESERVED', 'PICKING', 'PARTIALLY_FULFILLED')
           AND o._deleted = 0
         ORDER BY 
           CASE o.priority 
             WHEN 'CRITICAL' THEN 1 
             WHEN 'URGENT' THEN 2 
             WHEN 'HIGH' THEN 3 
             ELSE 4 
           END ASC,
           o.placed_at ASC`
      )
      .all(organizationId, storeId);

    return rows.map(r => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      fulfilmentId: r.fulfilment_id,
      customerName: r.customer_name || 'Customer',
      fulfilmentType: r.fulfilment_type,
      status: r.status,
      priority: r.priority,
      prescriptionStatus: r.prescription_status,
      totalItems: Number(r.total_items || 0),
      totalQuantity: Number(r.total_quantity || 0),
      placedAt: r.placed_at,
      isColdChain: Boolean(r.is_cold_chain),
    }));
  }

  /**
   * Start picking an order
   */
  static startPicking(params: {
    orderId: string;
    organizationId: string;
    pickerUserId: string;
    pickerName?: string;
  }): void {
    const { orderId, organizationId, pickerUserId, pickerName = 'Staff' } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?')
      .get(orderId, organizationId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    if (order.prescription_status === 'PENDING_REVIEW') {
      throw new AppError(
        400,
        'Cannot start picking: Prescription verification is still pending review by a pharmacist',
        'PRESCRIPTION_PENDING_REVIEW'
      );
    }

    OrderStateMachine.validateOrderTransition(order.status, 'PICKING');

    const nowIso = new Date().toISOString();

    localMutate({
      table: 'orders',
      operation: 'UPDATE',
      data: {
        id: orderId,
        status: 'PICKING',
        fulfilment_status: 'PICKING',
        updated_at: nowIso,
      },
    });

    localDb
      .prepare(
        `UPDATE order_fulfilments 
         SET status = 'PICKING', pick_started_at = ?, updated_at = ?, _updated_at = ?
         WHERE order_id = ?`
      )
      .run(nowIso, nowIso, nowIso, orderId);

    localDb
      .prepare(
        `UPDATE order_items 
         SET status = 'PICKING', updated_at = ?, _updated_at = ?
         WHERE order_id = ? AND status IN ('CONFIRMED', 'RESERVED')`
      )
      .run(nowIso, nowIso, orderId);

    OrderEventService.logEvent({
      orderId,
      organizationId,
      eventType: 'PICK_STARTED',
      fromStatus: order.status,
      toStatus: 'PICKING',
      actorId: pickerUserId,
      actorName: pickerName,
      notes: `Picking started by ${pickerName}`,
    });
  }

  /**
   * Scan barcode and pick item
   */
  static pickItem(params: {
    orderId: string;
    orderItemId: string;
    organizationId: string;
    scannedBarcode: string;
    pickedQuantity: number;
    pickedBatchId?: string | null;
    pickerUserId: string;
  }): { success: boolean; pickedQuantity: number; fulfilledQuantity: number; itemStatus: string } {
    const {
      orderId,
      orderItemId,
      organizationId,
      scannedBarcode,
      pickedQuantity,
      pickedBatchId = null,
      pickerUserId,
    } = params;

    const item: any = localDb
      .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
      .get(orderItemId, orderId);

    if (!item) {
      throw new AppError(404, 'Order item not found', 'ITEM_NOT_FOUND');
    }

    // 1. Barcode Verification: Scanned barcode must match item or product barcodes
    const medRow: any = localDb
      .prepare('SELECT * FROM medicines WHERE id = ? OR _local_id = ?')
      .get(item.medicine_id, item.medicine_id);

    const matchesBarcode =
      medRow?.primary_barcode === scannedBarcode ||
      medRow?.name?.toLowerCase() === scannedBarcode.toLowerCase() ||
      Boolean(
        localDb
          .prepare(
            'SELECT 1 FROM product_barcodes WHERE medicine_id = ? AND barcode = ? AND _deleted = 0'
          )
          .get(item.medicine_id, scannedBarcode)
      ) ||
      Boolean(
        localDb
          .prepare(
            'SELECT 1 FROM medicine_batches WHERE medicine_id = ? AND (batch_number = ? OR id = ?) AND _deleted = 0'
          )
          .get(item.medicine_id, scannedBarcode, scannedBarcode)
      );

    if (!matchesBarcode) {
      throw new AppError(
        400,
        `Scanned barcode '${scannedBarcode}' does not match expected medicine '${item.medicine_name}'`,
        'WRONG_BARCODE_SCANNED'
      );
    }

    // 2. Batch Validation: Revalidate expiry, recall, disposal
    let targetBatchId = pickedBatchId;
    if (!targetBatchId) {
      const allocRow: any = localDb
        .prepare('SELECT batch_id FROM order_fulfilment_items WHERE order_item_id = ?')
        .get(orderItemId);
      targetBatchId = allocRow?.batch_id || null;
    }

    if (targetBatchId) {
      const batchRow: any = localDb
        .prepare('SELECT * FROM medicine_batches WHERE id = ? OR _local_id = ?')
        .get(targetBatchId, targetBatchId);

      if (batchRow) {
        if (batchRow.is_disposed) {
          throw new AppError(400, `Batch ${batchRow.batch_number} is disposed and cannot be picked`, 'BATCH_DISPOSED');
        }
        if (batchRow.is_recalled) {
          throw new AppError(400, `Batch ${batchRow.batch_number} is recalled and cannot be picked`, 'BATCH_RECALLED');
        }
        if (batchRow.expiry_date && new Date(batchRow.expiry_date) <= new Date()) {
          throw new AppError(400, `Batch ${batchRow.batch_number} is expired (${batchRow.expiry_date}) and cannot be picked`, 'BATCH_EXPIRED');
        }
      }

      // Check if recalled
      const recallRow: any = localDb
        .prepare(
          `SELECT r.reason FROM product_recalls r 
           WHERE r.batch_id = ? AND r.status = 'ACTIVE' AND r._deleted = 0`
        )
        .get(targetBatchId);

      if (recallRow) {
        throw new AppError(
          400,
          `Batch is under statutory active recall: ${recallRow.reason}. Picking blocked.`,
          'BATCH_RECALLED'
        );
      }
    }

    const nowIso = new Date().toISOString();

    // Update fulfillment item & order item picked quantity
    localDb
      .prepare(
        `UPDATE order_fulfilment_items 
         SET quantity_picked = ?, status = 'PICKED', updated_at = ?, _updated_at = ?
         WHERE order_item_id = ?`
      )
      .run(pickedQuantity, nowIso, nowIso, orderItemId);

    const isFullPick = pickedQuantity >= Number(item.requested_quantity);
    localDb
      .prepare(
        `UPDATE order_items 
         SET fulfilled_quantity = ?, status = ?, updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(pickedQuantity, isFullPick ? 'PICKED' : 'PARTIALLY_FULFILLED', nowIso, nowIso, orderItemId);

    OrderEventService.logEvent({
      orderId,
      organizationId,
      eventType: 'ITEM_PICKED',
      actorId: pickerUserId,
      details: {
        orderItemId,
        medicineId: item.medicine_id,
        medicineName: item.medicine_name,
        quantity: pickedQuantity,
        batchId: targetBatchId,
      },
    });

    return {
      success: true,
      pickedQuantity,
      fulfilledQuantity: pickedQuantity,
      itemStatus: isFullPick ? 'PICKED' : 'PARTIALLY_FULFILLED',
    };
  }

  /**
   * Record pick shortage
   */
  static recordShortage(params: {
    orderId: string;
    orderItemId: string;
    organizationId: string;
    foundQuantity: number;
    reason?: string;
    pickerUserId: string;
  }): { shortageQuantity: number } {
    const { orderId, orderItemId, organizationId, foundQuantity, reason = 'PHYSICAL_SHORTAGE', pickerUserId } = params;

    const item: any = localDb
      .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
      .get(orderItemId, orderId);

    if (!item) {
      throw new AppError(404, 'Order item not found', 'ITEM_NOT_FOUND');
    }

    const reqQty = Number(item.requested_quantity || 1);
    const shortQty = Math.max(0, reqQty - foundQuantity);
    const nowIso = new Date().toISOString();

    localDb
      .prepare(
        `UPDATE order_items 
         SET fulfilled_quantity = ?, cancelled_quantity = ?, status = 'PARTIALLY_FULFILLED', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(foundQuantity, shortQty, nowIso, nowIso, orderItemId);

    localDb
      .prepare(
        `UPDATE order_fulfilment_items 
         SET quantity_picked = ?, status = 'PARTIALLY_FULFILLED', notes = ?, updated_at = ?, _updated_at = ?
         WHERE order_item_id = ?`
      )
      .run(foundQuantity, `Shortage reported: found ${foundQuantity}/${reqQty}. Reason: ${reason}`, nowIso, nowIso, orderItemId);

    OrderEventService.logEvent({
      orderId,
      organizationId,
      eventType: 'PICK_SHORTAGE',
      actorId: pickerUserId,
      details: {
        orderItemId,
        medicineName: item.medicine_name,
        requestedQuantity: reqQty,
        foundQuantity,
        shortQuantity: shortQty,
        reason,
      },
      notes: `Shortage of ${shortQty} units for ${item.medicine_name}`,
    });

    return { shortageQuantity: shortQty };
  }

  /**
   * Pack order items into physical package container and mark READY
   */
  static packOrder(params: {
    orderId: string;
    organizationId: string;
    packedByUserId: string;
    packedByName?: string;
    specialInstructions?: string;
  }): OrderPackage {
    const {
      orderId,
      organizationId,
      packedByUserId,
      packedByName = 'Staff',
      specialInstructions = '',
    } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?')
      .get(orderId, organizationId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    // Check if prescription required and verified
    if (order.prescription_status === 'PENDING_REVIEW' || order.prescription_status === 'REJECTED') {
      throw new AppError(
        400,
        `Cannot pack order: Prescription status is '${order.prescription_status}'`,
        'PRESCRIPTION_NOT_VERIFIED'
      );
    }

    const fulfilment: any = localDb
      .prepare('SELECT * FROM order_fulfilments WHERE order_id = ?')
      .get(orderId);

    const items: any[] = localDb
      .prepare('SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0')
      .all(orderId);

    // Identify cold chain and prescription requirements
    let isColdChain = false;
    let isPrescriptionRequired = false;

    for (const it of items) {
      const medRow: any = localDb
        .prepare('SELECT cold_chain_required, prescription_required FROM medicines WHERE id = ? OR _local_id = ?')
        .get(it.medicine_id, it.medicine_id);

      if (medRow?.cold_chain_required) isColdChain = true;
      if (medRow?.prescription_required || it.prescription_required) isPrescriptionRequired = true;
    }

    const packageId = uuidv4();
    const packageNumber = 1;
    const packageLabel = `PKG-${order.order_number}-${packageNumber}`;
    const nowIso = new Date().toISOString();

    const pkgRecord = localMutate({
      table: 'order_packages',
      operation: 'INSERT',
      data: {
        id: packageId,
        _local_id: packageId,
        order_id: orderId,
        fulfilment_id: fulfilment ? (fulfilment.id || fulfilment._local_id) : null,
        organization_id: organizationId,
        package_number: packageNumber,
        package_label: packageLabel,
        package_type: isColdChain ? 'INSULATED_COLD_BOX' : 'BOX',
        is_cold_chain: isColdChain ? 1 : 0,
        is_prescription_required: isPrescriptionRequired ? 1 : 0,
        packed_by: packedByUserId,
        packed_at: nowIso,
        special_instructions: specialInstructions || (isColdChain ? 'MAINTAIN 2°C - 8°C TEMPERATURE' : ''),
        seal_number: `SEAL-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        weight_kg: 0.5,
      },
    });

    // Populate order_package_items
    for (const it of items) {
      const allocRow: any = localDb
        .prepare('SELECT batch_id, quantity_picked FROM order_fulfilment_items WHERE order_item_id = ?')
        .get(it.id);

      const pkgItemId = uuidv4();
      localMutate({
        table: 'order_package_items',
        operation: 'INSERT',
        data: {
          id: pkgItemId,
          _local_id: pkgItemId,
          package_id: packageId,
          order_id: orderId,
          fulfilment_id: fulfilment ? (fulfilment.id || fulfilment._local_id) : null,
          order_item_id: it.id,
          medicine_id: it.medicine_id,
          batch_id: allocRow?.batch_id || null,
          quantity: allocRow?.quantity_picked || it.fulfilled_quantity || it.requested_quantity,
        },
      });
    }

    // Determine target ready status
    const targetStatus = order.fulfilment_type === 'HOME_DELIVERY' ? 'READY_FOR_DISPATCH' : 'READY_FOR_PICKUP';

    localMutate({
      table: 'orders',
      operation: 'UPDATE',
      data: {
        id: orderId,
        status: targetStatus,
        fulfilment_status: 'READY',
        ready_at: nowIso,
        updated_at: nowIso,
      },
    });

    localDb
      .prepare(
        `UPDATE order_fulfilments 
         SET status = 'READY', packed_at = ?, ready_at = ?, updated_at = ?, _updated_at = ?
         WHERE order_id = ?`
      )
      .run(nowIso, nowIso, nowIso, nowIso, orderId);

    OrderEventService.logEvent({
      orderId,
      fulfilmentId: fulfilment?.id || null,
      organizationId,
      eventType: 'PACKED',
      fromStatus: 'PICKING',
      toStatus: targetStatus,
      actorId: packedByUserId,
      actorName: packedByName,
      details: {
        packageLabel,
        isColdChain,
        isPrescriptionRequired,
      },
      notes: `Package ${packageLabel} assembled and marked ${targetStatus}`,
    });

    return {
      id: packageId,
      order_id: orderId,
      fulfilment_id: fulfilment?.id || null,
      organization_id: organizationId,
      package_number: packageNumber,
      package_label: packageLabel,
      package_type: isColdChain ? 'INSULATED_COLD_BOX' : 'BOX',
      is_cold_chain: isColdChain ? 1 : 0,
      is_prescription_required: isPrescriptionRequired ? 1 : 0,
      packed_by: packedByUserId,
      packed_at: nowIso,
      special_instructions: specialInstructions,
      seal_number: pkgRecord.seal_number,
      weight_kg: 0.5,
    };
  }
}
