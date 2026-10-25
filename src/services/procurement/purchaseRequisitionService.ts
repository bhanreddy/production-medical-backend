// purchaseRequisitionService.ts — Demand Consolidation & Requisition Lifecycle Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  PurchaseRequisition,
  PurchaseRequisitionItem,
  RequisitionSource,
  RequisitionPriority,
  RequisitionStatus,
} from '../../domain/procurementTypes';
import { DocumentNumberingService } from '../documentNumbering';
import { ProcurementPolicyService } from './procurementPolicyService';

export interface CreateRequisitionParams {
  organizationId: string;
  regionId?: string | null;
  storeId?: string | null;
  warehouseId?: string | null;
  source?: RequisitionSource;
  priority?: RequisitionPriority;
  requiredByDate?: string | null;
  notes?: string | null;
  requestedBy: string;
  items: Array<{
    medicineId: string;
    requestedUnit?: string;
    conversionFactor?: number;
    requestedQuantity: number;
    recommendedQuantity?: number;
    justification?: string;
    preferredSupplierId?: string | null;
    urgency?: RequisitionPriority;
    estimatedCostPaise?: number;
    sourceReference?: string | null;
  }>;
}

export class PurchaseRequisitionService {
  /**
   * Create a new purchase requisition with line items
   */
  static createRequisition(params: CreateRequisitionParams): PurchaseRequisition {
    const {
      organizationId,
      regionId = null,
      storeId = null,
      warehouseId = null,
      source = 'MANUAL',
      priority = 'MEDIUM',
      requiredByDate = null,
      notes = null,
      requestedBy,
      items,
    } = params;

    if (!items || items.length === 0) {
      throw new Error('Requisition must contain at least one item');
    }

    const requisitionId = uuidv4();
    const reqNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'PURCHASE_REQUISITION',
    });

    const nowIso = new Date().toISOString();

    const createdReq = localMutate({
      table: 'purchase_requisitions',
      operation: 'INSERT',
      data: {
        id: requisitionId,
        _local_id: requisitionId,
        organization_id: organizationId,
        region_id: regionId,
        store_id: storeId,
        warehouse_id: warehouseId,
        requisition_number: reqNumber,
        source,
        requested_by: requestedBy,
        requested_at: nowIso,
        priority,
        required_by_date: requiredByDate,
        status: 'DRAFT',
        notes,
      },
    });

    const createdItems: PurchaseRequisitionItem[] = [];

    for (const it of items) {
      const itemId = uuidv4();
      const unit = it.requestedUnit || 'strip';
      const convFactor = it.conversionFactor || 1.0;
      const baseQty = it.requestedQuantity * convFactor;

      // Lookup live inventory positions for context
      let stockOnHold = 0;
      let availStock = 0;
      let reservedStock = 0;
      let incomingStock = 0;

      const posRow: any = localDb
        .prepare(
          `SELECT SUM(quantity_on_hand) as on_hand, SUM(quantity_available) as avail,
                  SUM(quantity_reserved) as reserved, SUM(quantity_in_transit) as transit
           FROM inventory_positions
           WHERE organization_id = ? AND medicine_id = ? ${storeId ? 'AND store_id = ?' : ''}`
        )
        .get(storeId ? [organizationId, it.medicineId, storeId] : [organizationId, it.medicineId]);

      if (posRow) {
        stockOnHold = Number(posRow.on_hand || 0);
        availStock = Number(posRow.avail || 0);
        reservedStock = Number(posRow.reserved || 0);
        incomingStock = Number(posRow.transit || 0);
      }

      // Lookup standard or last rate from medicine or catalog
      let estCostPaise = it.estimatedCostPaise || 0;
      if (!estCostPaise) {
        const medRow: any = localDb.prepare('SELECT purchase_price FROM medicines WHERE id = ? OR _local_id = ?').get(it.medicineId, it.medicineId);
        if (medRow?.purchase_price) {
          estCostPaise = Money.toPaise(medRow.purchase_price) * it.requestedQuantity;
        }
      }

      const itemRecord = localMutate({
        table: 'purchase_requisition_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          requisition_id: requisitionId,
          organization_id: organizationId,
          medicine_id: it.medicineId,
          requested_unit: unit,
          conversion_factor: convFactor,
          base_quantity: baseQty,
          current_stock: stockOnHold,
          available_stock: availStock,
          reserved_stock: reservedStock,
          incoming_stock: incomingStock,
          recommended_quantity: it.recommendedQuantity || 0,
          requested_quantity: it.requestedQuantity,
          ordered_quantity: 0,
          justification: it.justification || null,
          preferred_supplier_id: it.preferredSupplierId || null,
          urgency: it.urgency || priority,
          estimated_cost_paise: estCostPaise,
          source_reference: it.sourceReference || null,
          status: 'PENDING',
        },
      });

      createdItems.push(itemRecord as any);
    }

    return {
      ...createdReq,
      items: createdItems,
    } as PurchaseRequisition;
  }

  /**
   * Submit requisition for approval
   */
  static submitRequisition(requisitionId: string, organizationId: string): PurchaseRequisition {
    const req = this.getRequisitionById(requisitionId, organizationId);
    if (!req) throw new Error('Requisition not found');
    if (req.status !== 'DRAFT') {
      throw new Error(`Cannot submit requisition in status: ${req.status}`);
    }

    const updated = localMutate({
      table: 'purchase_requisitions',
      operation: 'UPDATE',
      data: {
        _local_id: req._local_id || req.id,
        status: 'PENDING_APPROVAL',
      },
    });

    return this.getRequisitionById(requisitionId, organizationId)!;
  }

  /**
   * Approve a requisition with threshold verification
   */
  static approveRequisition(params: {
    requisitionId: string;
    organizationId: string;
    approvedBy: string;
    userRole: string; // e.g., 'STORE_MANAGER', 'REGIONAL_MANAGER', 'HQ_PROCUREMENT', 'OWNER', 'ADMIN'
  }): PurchaseRequisition {
    const { requisitionId, organizationId, approvedBy, userRole } = params;
    const req = this.getRequisitionById(requisitionId, organizationId);
    if (!req) throw new Error('Requisition not found');
    if (req.status !== 'PENDING_APPROVAL' && req.status !== 'DRAFT') {
      throw new Error(`Cannot approve requisition in status: ${req.status}`);
    }

    // Calculate total estimated value
    const totalEstPaise = (req.items || []).reduce((acc, item) => acc + (item.estimated_cost_paise || 0), 0);
    const requiredRole = ProcurementPolicyService.getRequiredApprovalRole(organizationId, totalEstPaise);

    // Verify role authority
    const roleWeight: Record<string, number> = {
      CASHIER: 1,
      PHARMACIST: 2,
      STORE_MANAGER: 3,
      REGIONAL_MANAGER: 4,
      HQ_PROCUREMENT: 5,
      ADMIN: 10,
      OWNER: 10,
    };

    const userWeight = roleWeight[userRole.toUpperCase()] || 1;
    const requiredWeight = roleWeight[requiredRole] || 3;

    if (userWeight < requiredWeight) {
      throw new Error(`Unauthorized: Value ₹${(totalEstPaise / 100).toFixed(2)} requires ${requiredRole} approval`);
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'purchase_requisitions',
      operation: 'UPDATE',
      data: {
        _local_id: req._local_id || req.id,
        status: 'APPROVED',
        approved_by: approvedBy,
        approved_at: nowIso,
      },
    });

    return this.getRequisitionById(requisitionId, organizationId)!;
  }

  /**
   * Reject a requisition with reason
   */
  static rejectRequisition(params: {
    requisitionId: string;
    organizationId: string;
    rejectedBy: string;
    rejectionReason: string;
  }): PurchaseRequisition {
    const { requisitionId, organizationId, rejectedBy, rejectionReason } = params;
    const req = this.getRequisitionById(requisitionId, organizationId);
    if (!req) throw new Error('Requisition not found');

    if (!rejectionReason || !rejectionReason.trim()) {
      throw new Error('Rejection reason is required');
    }

    const nowIso = new Date().toISOString();
    localMutate({
      table: 'purchase_requisitions',
      operation: 'UPDATE',
      data: {
        _local_id: req._local_id || req.id,
        status: 'REJECTED',
        rejected_by: rejectedBy,
        rejected_at: nowIso,
        rejection_reason: rejectionReason,
      },
    });

    return this.getRequisitionById(requisitionId, organizationId)!;
  }

  /**
   * Consolidate multi-store demand into a central warehouse requisition
   */
  static consolidateRequisitions(params: {
    organizationId: string;
    warehouseId: string;
    sourceRequisitionIds: string[];
    requestedBy: string;
    notes?: string;
  }): PurchaseRequisition {
    const { organizationId, warehouseId, sourceRequisitionIds, requestedBy, notes } = params;
    if (!sourceRequisitionIds || sourceRequisitionIds.length === 0) {
      throw new Error('Must specify source requisitions to consolidate');
    }

    const aggregatedMap = new Map<string, {
      medicineId: string;
      requestedQuantity: number;
      estimatedCostPaise: number;
      preferredSupplierId?: string | null;
      sourceRefs: string[];
    }>();

    for (const reqId of sourceRequisitionIds) {
      const req = this.getRequisitionById(reqId, organizationId);
      if (!req) continue;

      for (const it of req.items || []) {
        const existing = aggregatedMap.get(it.medicine_id);
        if (existing) {
          existing.requestedQuantity += Number(it.requested_quantity || 0);
          existing.estimatedCostPaise += Number(it.estimated_cost_paise || 0);
          existing.sourceRefs.push(`${req.requisition_number} (Store ${req.store_id || 'N/A'}: ${it.requested_quantity})`);
        } else {
          aggregatedMap.set(it.medicine_id, {
            medicineId: it.medicine_id,
            requestedQuantity: Number(it.requested_quantity || 0),
            estimatedCostPaise: Number(it.estimated_cost_paise || 0),
            preferredSupplierId: it.preferred_supplier_id,
            sourceRefs: [`${req.requisition_number} (Store ${req.store_id || 'N/A'}: ${it.requested_quantity})`],
          });
        }
      }
    }

    const consolidatedItems = Array.from(aggregatedMap.values()).map(entry => ({
      medicineId: entry.medicineId,
      requestedQuantity: entry.requestedQuantity,
      estimatedCostPaise: entry.estimatedCostPaise,
      preferredSupplierId: entry.preferredSupplierId,
      justification: `Consolidated Central Demand from: ${entry.sourceRefs.join(', ')}`,
      sourceReference: entry.sourceRefs.join('; '),
    }));

    return this.createRequisition({
      organizationId,
      warehouseId,
      source: 'WAREHOUSE_REPLENISHMENT',
      priority: 'HIGH',
      requestedBy,
      notes: notes || `Consolidation of ${sourceRequisitionIds.length} store requisitions`,
      items: consolidatedItems,
    });
  }

  /**
   * Fetch requisition with items & medicine names
   */
  static getRequisitionById(id: string, organizationId: string): PurchaseRequisition | null {
    const row: any = localDb
      .prepare(
        `SELECT * FROM purchase_requisitions
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const items: any[] = localDb
      .prepare(
        `SELECT pri.*, m.name as medicine_name, s.name as preferred_supplier_name
         FROM purchase_requisition_items pri
         LEFT JOIN medicines m ON m.id = pri.medicine_id OR m._local_id = pri.medicine_id
         LEFT JOIN suppliers s ON s.id = pri.preferred_supplier_id OR s._local_id = pri.preferred_supplier_id
         WHERE (pri.requisition_id = ? OR pri.requisition_id = ?) AND pri._deleted = 0`
      )
      .all(row.id, row._local_id || row.id);

    return {
      ...row,
      items,
    } as PurchaseRequisition;
  }

  /**
   * List requisitions with filtering
   */
  static listRequisitions(params: {
    organizationId: string;
    storeId?: string | null;
    warehouseId?: string | null;
    status?: RequisitionStatus;
    source?: RequisitionSource;
    limit?: number;
    offset?: number;
  }): { data: PurchaseRequisition[]; total: number } {
    const { organizationId, storeId, warehouseId, status, source, limit = 50, offset = 0 } = params;

    let query = `SELECT * FROM purchase_requisitions WHERE (organization_id = ?) AND _deleted = 0`;
    const values: any[] = [organizationId];

    if (storeId) {
      query += ` AND store_id = ?`;
      values.push(storeId);
    }
    if (warehouseId) {
      query += ` AND warehouse_id = ?`;
      values.push(warehouseId);
    }
    if (status) {
      query += ` AND status = ?`;
      values.push(status);
    }
    if (source) {
      query += ` AND source = ?`;
      values.push(source);
    }

    const countRow: any = localDb.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...values);
    const total = Number(countRow?.total || 0);

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const rows: any[] = localDb.prepare(query).all(...values);

    const data = rows.map(r => this.getRequisitionById(r.id, organizationId)!);
    return { data, total };
  }

  /**
   * Bulk generate purchase requisition draft from Reorder Recommendations
   */
  static createRequisitionFromRecommendations(params: {
    organizationId: string;
    storeId?: string | null;
    recommendations: Array<{
      medicineId: string;
      recommendedQuantity: number;
      reason?: string;
      packSize?: number;
    }>;
    requestedBy: string;
  }): PurchaseRequisition {
    const { organizationId, storeId = null, recommendations, requestedBy } = params;

    const items = recommendations.map(rec => ({
      medicineId: rec.medicineId,
      requestedQuantity: rec.recommendedQuantity,
      recommendedQuantity: rec.recommendedQuantity,
      justification: rec.reason || 'Generated from Reorder Intelligence Engine',
      urgency: 'HIGH' as RequisitionPriority,
    }));

    return this.createRequisition({
      organizationId,
      storeId,
      source: 'REORDER_ENGINE',
      priority: 'HIGH',
      requestedBy,
      notes: `Auto-generated draft from ${recommendations.length} reorder recommendations`,
      items,
    });
  }

  /**
   * Generate purchase requisition draft from Shortbook items
   */
  static createRequisitionFromShortbook(params: {
    organizationId: string;
    storeId?: string | null;
    shortbookItems: Array<{
      medicineId: string;
      quantityNeeded: number;
      reason?: string;
      preferredSupplierId?: string | null;
    }>;
    requestedBy: string;
  }): PurchaseRequisition {
    const { organizationId, storeId = null, shortbookItems, requestedBy } = params;

    const items = shortbookItems.map(s => ({
      medicineId: s.medicineId,
      requestedQuantity: s.quantityNeeded,
      recommendedQuantity: s.quantityNeeded,
      justification: s.reason || 'High customer demand shortbook item',
      preferredSupplierId: s.preferredSupplierId || null,
      urgency: 'HIGH' as RequisitionPriority,
    }));

    return this.createRequisition({
      organizationId,
      storeId,
      source: 'SHORTBOOK',
      priority: 'HIGH',
      requestedBy,
      notes: `Requisition generated from ${shortbookItems.length} Shortbook customer demand entries`,
      items,
    });
  }
}
