// purchaseOrderService.ts — Enterprise Purchase Order, Versioning & Supplier Confirmation Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
  PurchaseOrderVersion,
} from '../../domain/procurementTypes';
import { DocumentNumberingService } from '../documentNumbering';
import { ProcurementPolicyService } from './procurementPolicyService';
import { SupplierSchemeEngine } from '../commercial/supplierSchemeEngine';
import { businessDate } from '../../lib/businessDate';

export interface CreatePurchaseOrderParams {
  organizationId: string;
  regionId?: string | null;
  storeId?: string | null;
  warehouseId?: string | null;
  supplierId: string;
  expectedDeliveryDate?: string | null;
  paymentTerms?: string;
  deliveryLocationType?: 'STORE' | 'WAREHOUSE';
  deliveryLocationId?: string | null;
  notes?: string | null;
  termsAndConditions?: string | null;
  idempotencyKey?: string | null;
  createdBy: string;
  items: Array<{
    medicineId: string;
    purchaseUnit?: string;
    conversionFactor?: number;
    orderedQuantity: number;
    purchaseRatePaise: number;
    mrpExpectedPaise?: number;
    discountPct?: number;
    gstRate?: number;
    supplierSchemeId?: string | null;
    expectedExpiryThresholdDays?: number;
    requiredByDate?: string | null;
    notes?: string | null;
    requisitionItemId?: string | null;
    requisitionId?: string | null;
  }>;
}

export class PurchaseOrderService {
  /**
   * Create a new Purchase Order
   */
  static createPurchaseOrder(params: CreatePurchaseOrderParams): PurchaseOrder {
    const {
      organizationId,
      regionId = null,
      storeId = null,
      warehouseId = null,
      supplierId,
      expectedDeliveryDate = null,
      paymentTerms = 'NET_30',
      deliveryLocationType = 'STORE',
      deliveryLocationId = storeId || warehouseId,
      notes = null,
      termsAndConditions = null,
      idempotencyKey = null,
      createdBy,
      items,
    } = params;

    if (!items || items.length === 0) {
      throw new Error('Purchase order must contain at least one item');
    }

    // Duplicate PO Protection via idempotencyKey
    if (idempotencyKey) {
      const existingPo = this.getPoByIdempotencyKey(organizationId, idempotencyKey);
      if (existingPo) {
        return existingPo;
      }
    }

    const poId = uuidv4();
    const poNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'PURCHASE_ORDER',
    });

    const nowIso = new Date().toISOString();
    const timezone = (localDb.prepare('SELECT timezone FROM organizations WHERE id = ? OR _local_id = ?').get(organizationId, organizationId) as { timezone?: string } | undefined)?.timezone;
    const orderDate = businessDate(new Date(nowIso), timezone || 'Asia/Kolkata');

    // Calculate line totals and scheme benefits
    let subtotalPaise = 0;
    let discountPaise = 0;
    let gstPaise = 0;
    const poItemRecords: PurchaseOrderItem[] = [];
    const reqLinks: Array<{ poItemId: string; reqId: string; reqItemId: string; qty: number }> = [];

    for (const it of items) {
      const itemId = uuidv4();
      const unit = it.purchaseUnit || 'strip';
      const convFactor = it.conversionFactor || 1.0;
      const rateRs = Money.toRupees(it.purchaseRatePaise);
      const discountPct = it.discountPct || 0;
      const gstRate = it.gstRate !== undefined ? it.gstRate : 12.0;

      // Evaluate scheme for free quantity & effective cost estimate
      const schemeResult = SupplierSchemeEngine.evaluateInwardScheme({
        organizationId,
        supplierId,
        medicineId: it.medicineId,
        billedQuantity: it.orderedQuantity,
        purchasePrice: rateRs,
        requestedDiscountPct: discountPct,
      });

      const lineGrossPaise = it.purchaseRatePaise * it.orderedQuantity;
      const lineDiscAmtPaise = Math.round((lineGrossPaise * schemeResult.tradeDiscountPct) / 100);
      const lineTaxablePaise = lineGrossPaise - lineDiscAmtPaise;
      const lineGstPaise = Math.round((lineTaxablePaise * gstRate) / 100);

      subtotalPaise += lineGrossPaise;
      discountPaise += lineDiscAmtPaise;
      gstPaise += lineGstPaise;

      let schemeSummary = null;
      if (schemeResult.freeQuantity > 0) {
        schemeSummary = `Expected ${schemeResult.freeQuantity} free (${it.orderedQuantity}+${schemeResult.freeQuantity})`;
      }

      const itemRecord = localMutate({
        table: 'purchase_order_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          po_id: poId,
          organization_id: organizationId,
          medicine_id: it.medicineId,
          purchase_unit: unit,
          conversion_factor: convFactor,
          ordered_quantity: it.orderedQuantity,
          received_quantity: 0,
          free_quantity_expected: schemeResult.freeQuantity,
          purchase_rate_paise: it.purchaseRatePaise,
          mrp_expected_paise: it.mrpExpectedPaise || 0,
          discount_pct: schemeResult.tradeDiscountPct,
          gst_rate: gstRate,
          supplier_scheme_id: it.supplierSchemeId || null,
          scheme_summary: schemeSummary,
          effective_cost_paise: schemeResult.effectiveUnitCostPaise,
          expected_expiry_threshold_days: it.expectedExpiryThresholdDays || 180,
          required_by_date: it.requiredByDate || null,
          notes: it.notes || null,
        },
      });

      poItemRecords.push(itemRecord as any);

      if (it.requisitionId && it.requisitionItemId) {
        reqLinks.push({
          poItemId: itemId,
          reqId: it.requisitionId,
          reqItemId: it.requisitionItemId,
          qty: it.orderedQuantity,
        });
      }
    }

    const totalPaise = subtotalPaise - discountPaise + gstPaise;

    const poHeader = localMutate({
      table: 'purchase_orders',
      operation: 'INSERT',
      data: {
        id: poId,
        _local_id: poId,
        organization_id: organizationId,
        region_id: regionId,
        store_id: storeId,
        warehouse_id: warehouseId,
        supplier_id: supplierId,
        po_number: poNumber,
        currency: 'INR',
        order_date: orderDate,
        expected_delivery_date: expectedDeliveryDate,
        payment_terms: paymentTerms,
        delivery_location_type: deliveryLocationType,
        delivery_location_id: deliveryLocationId,
        status: 'DRAFT',
        subtotal_paise: subtotalPaise,
        discount_paise: discountPaise,
        gst_paise: gstPaise,
        total_paise: totalPaise,
        version: 1,
        created_by: createdBy,
        notes,
        terms_and_conditions: termsAndConditions,
        idempotency_key: idempotencyKey,
      },
    });

    // Create Initial Version Snapshot
    localMutate({
      table: 'purchase_order_versions',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        po_id: poId,
        version_number: 1,
        snapshot_json: JSON.stringify({ poHeader, items: poItemRecords }),
        change_reason: 'Initial PO Creation',
        changed_by: createdBy,
        created_at: nowIso,
      },
    });

    // Link and update source requisition items
    for (const link of reqLinks) {
      localMutate({
        table: 'purchase_order_requisition_links',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          po_id: poId,
          po_item_id: link.poItemId,
          requisition_id: link.reqId,
          requisition_item_id: link.reqItemId,
          allocated_quantity: link.qty,
        },
      });

      // Update requisition item ordered qty and status
      const reqItem: any = localDb.prepare('SELECT * FROM purchase_requisition_items WHERE id = ? OR _local_id = ?').get(link.reqItemId, link.reqItemId);
      if (reqItem) {
        const newOrderedQty = Number(reqItem.ordered_quantity || 0) + link.qty;
        const isComplete = newOrderedQty >= Number(reqItem.requested_quantity || 0);
        localMutate({
          table: 'purchase_requisition_items',
          operation: 'UPDATE',
          data: {
            _local_id: reqItem._local_id || reqItem.id,
            ordered_quantity: newOrderedQty,
            status: isComplete ? 'ORDERED' : 'PENDING',
          },
        });
      }

      // Check if entire requisition is ordered or partially ordered
      const allReqItems: any[] = localDb.prepare('SELECT requested_quantity, ordered_quantity FROM purchase_requisition_items WHERE requisition_id = ?').all(link.reqId);
      const totalReq = allReqItems.reduce((acc, r) => acc + Number(r.requested_quantity || 0), 0);
      const totalOrd = allReqItems.reduce((acc, r) => acc + Number(r.ordered_quantity || 0), 0);
      const newStatus = totalOrd >= totalReq ? 'ORDERED' : 'PARTIALLY_ORDERED';

      localMutate({
        table: 'purchase_requisitions',
        operation: 'UPDATE',
        data: {
          _local_id: link.reqId,
          status: newStatus,
        },
      });
    }

    return this.getPoById(poId, organizationId)!;
  }

  /**
   * Approve a Purchase Order
   */
  static approvePurchaseOrder(params: {
    poId: string;
    organizationId: string;
    approvedBy: string;
    userRole: string;
  }): PurchaseOrder {
    const { poId, organizationId, approvedBy, userRole } = params;
    const po = this.getPoById(poId, organizationId);
    if (!po) throw new Error('Purchase Order not found');

    if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') {
      throw new Error(`Cannot approve PO in status: ${po.status}`);
    }

    const policy = ProcurementPolicyService.getPolicy(organizationId);

    // Maker-checker validation if configured
    if (policy.enforceMakerChecker && po.created_by === approvedBy) {
      throw new Error('Maker-Checker Violation: PO creator cannot approve their own PO');
    }

    // Role threshold validation
    const requiredRole = ProcurementPolicyService.getRequiredApprovalRole(organizationId, po.total_paise);
    const roleWeight: Record<string, number> = {
      CASHIER: 1,
      PHARMACIST: 2,
      STORE_MANAGER: 3,
      REGIONAL_MANAGER: 4,
      HQ_PROCUREMENT: 5,
      ADMIN: 10,
      OWNER: 10,
    };
    if ((roleWeight[userRole.toUpperCase()] || 1) < (roleWeight[requiredRole] || 3)) {
      throw new Error(`Unauthorized: Value ₹${(po.total_paise / 100).toFixed(2)} requires ${requiredRole} approval`);
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'purchase_orders',
      operation: 'UPDATE',
      data: {
        _local_id: po._local_id || po.id,
        status: 'APPROVED',
        approved_by: approvedBy,
        approved_at: nowIso,
      },
    });

    return this.getPoById(poId, organizationId)!;
  }

  /**
   * Amend an approved PO creating a new version
   */
  static amendPurchaseOrder(params: {
    poId: string;
    organizationId: string;
    amendedBy: string;
    changeReason: string;
    expectedDeliveryDate?: string | null;
    items: Array<{
      medicineId: string;
      orderedQuantity: number;
      purchaseRatePaise: number;
      discountPct?: number;
      gstRate?: number;
      notes?: string;
    }>;
  }): PurchaseOrder {
    const { poId, organizationId, amendedBy, changeReason, expectedDeliveryDate, items } = params;
    const po = this.getPoById(poId, organizationId);
    if (!po) throw new Error('Purchase Order not found');

    if (po.status === 'RECEIVED' || po.status === 'CLOSED' || po.status === 'CANCELLED') {
      throw new Error(`Cannot amend PO in finalized status: ${po.status}`);
    }

    if (!changeReason || !changeReason.trim()) {
      throw new Error('Change reason is required for PO amendment');
    }

    const newVersionNumber = (po.version || 1) + 1;
    const nowIso = new Date().toISOString();

    // Delete old items and re-insert new items
    localDb.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(po.id);

    let subtotalPaise = 0;
    let discountPaise = 0;
    let gstPaise = 0;
    const poItemRecords: PurchaseOrderItem[] = [];

    for (const it of items) {
      const itemId = uuidv4();
      const discountPct = it.discountPct || 0;
      const gstRate = it.gstRate !== undefined ? it.gstRate : 12.0;

      const schemeResult = SupplierSchemeEngine.evaluateInwardScheme({
        organizationId,
        supplierId: po.supplier_id,
        medicineId: it.medicineId,
        billedQuantity: it.orderedQuantity,
        purchasePrice: Money.toRupees(it.purchaseRatePaise),
        requestedDiscountPct: discountPct,
      });

      const lineGross = it.purchaseRatePaise * it.orderedQuantity;
      const lineDiscAmt = Math.round((lineGross * schemeResult.tradeDiscountPct) / 100);
      const lineTaxable = lineGross - lineDiscAmt;
      const lineGst = Math.round((lineTaxable * gstRate) / 100);

      subtotalPaise += lineGross;
      discountPaise += lineDiscAmt;
      gstPaise += lineGst;

      const itemRecord = localMutate({
        table: 'purchase_order_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          po_id: po.id,
          organization_id: organizationId,
          medicine_id: it.medicineId,
          purchase_unit: 'strip',
          conversion_factor: 1.0,
          ordered_quantity: it.orderedQuantity,
          received_quantity: 0,
          free_quantity_expected: schemeResult.freeQuantity,
          purchase_rate_paise: it.purchaseRatePaise,
          mrp_expected_paise: 0,
          discount_pct: schemeResult.tradeDiscountPct,
          gst_rate: gstRate,
          effective_cost_paise: schemeResult.effectiveUnitCostPaise,
          expected_expiry_threshold_days: 180,
          notes: it.notes || null,
        },
      });
      poItemRecords.push(itemRecord as any);
    }

    const totalPaise = subtotalPaise - discountPaise + gstPaise;

    const updatedPo = localMutate({
      table: 'purchase_orders',
      operation: 'UPDATE',
      data: {
        _local_id: po._local_id || po.id,
        version: newVersionNumber,
        subtotal_paise: subtotalPaise,
        discount_paise: discountPaise,
        gst_paise: gstPaise,
        total_paise: totalPaise,
        expected_delivery_date: expectedDeliveryDate !== undefined ? expectedDeliveryDate : po.expected_delivery_date,
        status: 'PENDING_APPROVAL', // Requires re-approval after material amendment
      },
    });

    // Record immutable version snapshot
    localMutate({
      table: 'purchase_order_versions',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        po_id: po.id,
        version_number: newVersionNumber,
        snapshot_json: JSON.stringify({ updatedPo, items: poItemRecords }),
        change_reason: changeReason,
        changed_by: amendedBy,
        created_at: nowIso,
      },
    });

    return this.getPoById(poId, organizationId)!;
  }

  /**
   * Record Supplier Confirmation Details
   */
  static recordSupplierConfirmation(params: {
    poId: string;
    organizationId: string;
    expectedDeliveryDate?: string;
    notes?: string;
  }): PurchaseOrder {
    const { poId, organizationId, expectedDeliveryDate, notes } = params;
    const po = this.getPoById(poId, organizationId);
    if (!po) throw new Error('Purchase Order not found');

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'purchase_orders',
      operation: 'UPDATE',
      data: {
        _local_id: po._local_id || po.id,
        status: 'CONFIRMED',
        confirmed_at: nowIso,
        expected_delivery_date: expectedDeliveryDate || po.expected_delivery_date,
        notes: notes ? `${po.notes || ''}\nSupplier Confirmation: ${notes}`.trim() : po.notes,
      },
    });

    return this.getPoById(poId, organizationId)!;
  }

  /**
   * Cancel a Purchase Order
   */
  static cancelPurchaseOrder(params: {
    poId: string;
    organizationId: string;
    cancelledBy: string;
    reason: string;
  }): PurchaseOrder {
    const { poId, organizationId, reason } = params;
    const po = this.getPoById(poId, organizationId);
    if (!po) throw new Error('Purchase Order not found');

    if (po.status === 'RECEIVED' || po.status === 'CLOSED') {
      throw new Error(`Cannot cancel PO in status: ${po.status}`);
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'purchase_orders',
      operation: 'UPDATE',
      data: {
        _local_id: po._local_id || po.id,
        status: 'CANCELLED',
        cancelled_at: nowIso,
        rejection_reason: reason,
      },
    });

    return this.getPoById(poId, organizationId)!;
  }

  /**
   * Fetch PO by ID with items, versions, and supplier metadata
   */
  static getPoById(id: string, organizationId: string): PurchaseOrder | null {
    const row: any = localDb
      .prepare(
        `SELECT po.*, s.name as supplier_name
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id OR s._local_id = po.supplier_id
         WHERE (po.id = ? OR po._local_id = ?) AND (po.organization_id = ?) AND po._deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const items: any[] = localDb
      .prepare(
        `SELECT poi.*, m.name as medicine_name
         FROM purchase_order_items poi
         LEFT JOIN medicines m ON m.id = poi.medicine_id OR m._local_id = poi.medicine_id
         WHERE (poi.po_id = ? OR poi.po_id = ?) AND poi._deleted = 0`
      )
      .all(row.id, row._local_id || row.id);

    const versions: any[] = localDb
      .prepare(`SELECT * FROM purchase_order_versions WHERE po_id = ? ORDER BY version_number ASC`)
      .all(row.id);

    return {
      ...row,
      items,
      versions,
    } as PurchaseOrder;
  }

  /**
   * Fetch PO by Idempotency Key
   */
  static getPoByIdempotencyKey(organizationId: string, idempotencyKey: string): PurchaseOrder | null {
    const row: any = localDb
      .prepare(
        `SELECT id FROM purchase_orders
         WHERE (organization_id = ?)
           AND idempotency_key = ? AND _deleted = 0 LIMIT 1`
      )
      .get(organizationId, idempotencyKey);

    return row ? this.getPoById(row.id, organizationId) : null;
  }

  /**
   * List Purchase Orders with filters
   */
  static listPurchaseOrders(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId?: string | null;
    status?: PurchaseOrderStatus;
    limit?: number;
    offset?: number;
  }): { data: PurchaseOrder[]; total: number } {
    const { organizationId, storeId, supplierId, status, limit = 50, offset = 0 } = params;

    let query = `
      SELECT po.*, s.name as supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id OR s._local_id = po.supplier_id
      WHERE (po.organization_id = ?) AND po._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (storeId) {
      query += ` AND po.store_id = ?`;
      values.push(storeId);
    }
    if (supplierId) {
      query += ` AND (po.supplier_id = ? OR po.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }
    if (status) {
      query += ` AND po.status = ?`;
      values.push(status);
    }

    const countRow: any = localDb.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...values);
    const total = Number(countRow?.total || 0);

    query += ` ORDER BY po.order_date DESC, po.created_at DESC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const rows: any[] = localDb.prepare(query).all(...values);
    const data = rows.map(r => this.getPoById(r.id, organizationId)!);

    return { data, total };
  }
}
