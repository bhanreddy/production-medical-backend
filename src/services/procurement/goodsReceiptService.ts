// goodsReceiptService.ts — Enterprise Goods Receipt Note (GRN), Batch Inward & Multi-State Stock Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  GoodsReceipt,
  GoodsReceiptItem,
  GoodsReceiptStatus,
} from '../../domain/procurementTypes';
import { DocumentNumberingService } from '../documentNumbering';
import { ProcurementPolicyService } from './procurementPolicyService';
import { InventoryPositionService } from '../inventoryPosition';
import { SupplierSchemeEngine } from '../commercial/supplierSchemeEngine';

export interface CreateGoodsReceiptParams {
  organizationId: string;
  storeId?: string | null;
  warehouseId?: string | null;
  supplierId: string;
  poId?: string | null;
  supplierDeliveryNote?: string | null;
  receivedBy: string;
  notes?: string | null;
  items: Array<{
    poItemId?: string | null;
    medicineId: string;
    batchNumber: string;
    manufacturingDate?: string | null;
    expiryDate: string;
    orderedQuantity?: number;
    receivedPaidQuantity: number;
    freeQuantity?: number;
    rejectedQuantity?: number;
    damagedQuantity?: number;
    shortQuantity?: number;
    excessQuantity?: number;
    purchaseRatePaise: number;
    mrpPaise?: number;
    gstRate?: number;
    discountPct?: number;
    rejectionReason?: string | null;
    damageNotes?: string | null;
  }>;
}

export class GoodsReceiptService {
  /**
   * Create a new Goods Receipt Note (GRN) draft
   */
  static createGoodsReceipt(params: CreateGoodsReceiptParams): GoodsReceipt {
    const {
      organizationId,
      storeId = null,
      warehouseId = null,
      supplierId,
      poId = null,
      supplierDeliveryNote = null,
      receivedBy,
      notes = null,
      items,
    } = params;

    if (!items || items.length === 0) {
      throw new Error('GRN must contain at least one item');
    }

    const policy = ProcurementPolicyService.getPolicy(organizationId);
    const grnId = uuidv4();
    const grnNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'GRN',
    });

    const nowIso = new Date().toISOString();
    let initialStatus: GoodsReceiptStatus = 'RECEIVING';

    // Validate shelf-life against policy
    const today = new Date();
    for (const it of items) {
      const expDate = new Date(it.expiryDate);
      const diffDays = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays < policy.minShelfLifeDaysReceipt) {
        initialStatus = 'REVIEW'; // Requires review for near-expiry receipt
      }
    }

    const grnHeader = localMutate({
      table: 'goods_receipts',
      operation: 'INSERT',
      data: {
        id: grnId,
        _local_id: grnId,
        organization_id: organizationId,
        store_id: storeId,
        warehouse_id: warehouseId,
        supplier_id: supplierId,
        po_id: poId,
        grn_number: grnNumber,
        supplier_delivery_note: supplierDeliveryNote,
        received_at: nowIso,
        received_by: receivedBy,
        status: initialStatus,
        notes,
      },
    });

    const grnItemRecords: GoodsReceiptItem[] = [];

    for (const it of items) {
      const itemId = uuidv4();
      const paidQty = it.receivedPaidQuantity;
      const freeQty = it.freeQuantity || 0;
      const rejQty = it.rejectedQuantity || 0;
      const dmgQty = it.damagedQuantity || 0;
      const orderedQty = it.orderedQuantity || 0;

      // Net accepted sound units = (Paid + Free) - Rejected - Damaged
      const totalPhysical = paidQty + freeQty;
      const acceptedQty = Math.max(0, totalPhysical - rejQty - dmgQty);

      // Evaluate excess / short
      let shortQty = it.shortQuantity || 0;
      let excessQty = it.excessQuantity || 0;
      if (orderedQty > 0) {
        if (paidQty < orderedQty) {
          shortQty = orderedQty - paidQty;
        } else if (paidQty > orderedQty) {
          excessQty = paidQty - orderedQty;
          const excessPct = (excessQty / orderedQty) * 100;
          if (excessPct > policy.allowExcessReceiptTolerancePct) {
            initialStatus = 'REVIEW'; // Requires supervisor review for excess
          }
        }
      }

      // Calculate effective unit acquisition cost
      const grossPaise = it.purchaseRatePaise * paidQty;
      const discAmtPaise = Math.round((grossPaise * (it.discountPct || 0)) / 100);
      const netPaidPaise = grossPaise - discAmtPaise;
      const effectiveCostPaise = acceptedQty > 0 ? Math.round(netPaidPaise / acceptedQty) : it.purchaseRatePaise;

      let schemeSummary = null;
      if (freeQty > 0) {
        schemeSummary = `Received ${freeQty} free units with ${paidQty} paid`;
      }

      const itemRecord = localMutate({
        table: 'goods_receipt_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          grn_id: grnId,
          po_item_id: it.poItemId || null,
          organization_id: organizationId,
          medicine_id: it.medicineId,
          batch_number: it.batchNumber,
          manufacturing_date: it.manufacturingDate || null,
          expiry_date: it.expiryDate,
          ordered_quantity: orderedQty,
          received_paid_quantity: paidQty,
          free_quantity: freeQty,
          rejected_quantity: rejQty,
          damaged_quantity: dmgQty,
          short_quantity: shortQty,
          excess_quantity: excessQty,
          accepted_quantity: acceptedQty,
          purchase_rate_paise: it.purchaseRatePaise,
          mrp_paise: it.mrpPaise || 0,
          gst_rate: it.gstRate !== undefined ? it.gstRate : 12.0,
          discount_pct: it.discountPct || 0.0,
          scheme_summary: schemeSummary,
          effective_cost_paise: effectiveCostPaise,
          rejection_reason: it.rejectionReason || null,
          damage_notes: it.damageNotes || null,
        },
      });

      grnItemRecords.push(itemRecord as any);
    }

    // Update status if flagged for review
    if (initialStatus === 'REVIEW') {
      localMutate({
        table: 'goods_receipts',
        operation: 'UPDATE',
        data: {
          _local_id: grnId,
          status: 'REVIEW',
        },
      });
    }

    return this.getGrnById(grnId, organizationId)!;
  }

  /**
   * Post Goods Receipt Note (GRN):
   * - Increments physical inventory and updates batches with blended weighted acquisition cost
   * - Segregates available vs damaged/quarantined units
   * - Appends immutable stock ledger movements (movement_type = 'PURCHASE_RECEIPT')
   * - Updates PO received quantities and status (PARTIALLY_RECEIVED / RECEIVED)
   * - Never inventories rejected units
   * - Idempotent protection against double posting
   */
  static postGoodsReceipt(params: {
    grnId: string;
    organizationId: string;
    postedBy: string;
  }): GoodsReceipt {
    const { grnId, organizationId, postedBy } = params;
    const grn = this.getGrnById(grnId, organizationId);
    if (!grn) throw new Error('Goods Receipt Note not found');

    if (grn.status === 'POSTED') {
      return grn; // Idempotent: return already posted GRN
    }

    if (grn.status === 'CANCELLED') {
      throw new Error('Cannot post a cancelled GRN');
    }

    const policy = ProcurementPolicyService.getPolicy(organizationId);

    // Concurrency & PO Tolerance Lock
    if (grn.po_id) {
      const po: any = localDb.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(grn.po_id);
      if (po) {
        for (const item of grn.items || []) {
          if (item.po_item_id) {
            const poItem: any = localDb.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(item.po_item_id);
            if (poItem) {
              const currentReceived = Number(poItem.received_quantity || 0);
              const ordered = Number(poItem.ordered_quantity || 0);
              const maxAllowed = ordered * (1 + policy.allowExcessReceiptTolerancePct / 100);

              if (currentReceived + item.received_paid_quantity > maxAllowed && grn.status !== 'REVIEW') {
                throw new Error(`Receipt exceeds remaining PO quantity and tolerance for item: ${item.medicine_id}`);
              }
            }
          }
        }
      }
    }

    const locationType = grn.warehouse_id ? 'WAREHOUSE' : 'STORE';
    const storeId = grn.store_id || null;
    const warehouseId = grn.warehouse_id || null;

    // Process each line item for batch creation, stock positions, and ledger entries
    for (const item of grn.items || []) {
      const acceptedUnits = Number(item.accepted_quantity || 0);
      const damagedUnits = Number(item.damaged_quantity || 0);
      const sellableUnits = Math.max(0, acceptedUnits - damagedUnits);
      const unitCostRs = Money.toRupees(item.effective_cost_paise);
      const mrpRs = Money.toRupees(item.mrp_paise);

      if (acceptedUnits <= 0) {
        continue; // Rejected items are NOT inventoried
      }

      // 1. Batch Creation / Update with Weighted Blended Purchase Price
      const existingBatch: any = localDb
        .prepare(
          `SELECT * FROM medicine_batches
           WHERE (medicine_id = ? OR medicine_id = ?)
             AND batch_number = ?
             AND (organization_id = ?)
             ${storeId ? 'AND (store_id = ? OR store_id IS NULL)' : ''}
           LIMIT 1`
        )
        .get(storeId ? [item.medicine_id, item.medicine_id, item.batch_number, organizationId, storeId] : [item.medicine_id, item.medicine_id, item.batch_number, organizationId]);

      let batchId: string;
      let newBatchQty: number;

      if (existingBatch) {
        batchId = existingBatch.id || existingBatch._local_id;
        const oldQty = Number(existingBatch.quantity_remaining || 0);
        const oldPp = Number(existingBatch.purchase_price || 0);
        newBatchQty = oldQty + acceptedUnits;

        const blendedPriceRs = Money.calculateBlendedPurchasePrice({
          existingQuantity: oldQty,
          existingPurchasePrice: oldPp,
          newQuantity: acceptedUnits,
          newPurchasePrice: unitCostRs,
        });

        localMutate({
          table: 'medicine_batches',
          operation: 'UPDATE',
          data: {
            _local_id: existingBatch._local_id || existingBatch.id,
            quantity_remaining: newBatchQty,
            purchase_price: blendedPriceRs,
            cost_price_paise: Money.toPaise(blendedPriceRs),
            expiry_date: item.expiry_date || existingBatch.expiry_date,
            mrp: mrpRs > 0 ? mrpRs : existingBatch.mrp,
            organization_id: organizationId,
            store_id: storeId,
          },
        });
      } else {
        batchId = uuidv4();
        newBatchQty = acceptedUnits;

        localMutate({
          table: 'medicine_batches',
          operation: 'INSERT',
          data: {
            id: batchId,
            _local_id: batchId,
            organization_id: organizationId,
            store_id: storeId,
            medicine_id: item.medicine_id,
            supplier_id: grn.supplier_id,
            batch_number: item.batch_number,
            expiry_date: item.expiry_date,
            quantity_in: acceptedUnits,
            quantity_remaining: acceptedUnits,
            purchase_price: unitCostRs,
            cost_price_paise: item.effective_cost_paise,
            mrp: mrpRs,
          },
        });
      }

      // 2. Adjust Multi-State Inventory Position (Available vs Damaged/Quarantined)
      try {
        InventoryPositionService.adjustStock({
          organizationId,
          medicineId: item.medicine_id,
          batchId,
          locationType,
          storeId,
          warehouseId,
          quantityDelta: acceptedUnits + damagedUnits,
        });

        if (damagedUnits > 0) {
          // Move damaged portion into damaged state
          InventoryPositionService.updateStateQuantities({
            organizationId,
            medicineId: item.medicine_id,
            batchId,
            locationType,
            storeId,
            warehouseId,
            damagedDelta: damagedUnits,
          });
        }
      } catch {
        InventoryPositionService.getOrCreatePosition({
          organizationId,
          medicineId: item.medicine_id,
          batchId,
          locationType,
          storeId,
          warehouseId,
          initialStock: sellableUnits,
        });
      }

      // 3. Append Immutable Stock Ledger Entry
      localMutate({
        table: 'stock_ledger',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          _local_id: uuidv4(),
          organization_id: organizationId,
          store_id: storeId,
          warehouse_id: warehouseId,
          medicine_id: item.medicine_id,
          batch_id: batchId,
          movement_type: 'PURCHASE_RECEIPT',
          quantity_delta: acceptedUnits,
          balance_after: newBatchQty,
          reference_id: grn.id,
          notes: `GRN ${grn.grn_number} receipt (${item.received_paid_quantity} paid + ${item.free_quantity || 0} free${damagedUnits > 0 ? `, ${damagedUnits} damaged` : ''})`,
          performed_by: postedBy,
        },
      });

      // 4. Update PO Item Received Quantity
      if (item.po_item_id) {
        const poItem: any = localDb.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(item.po_item_id);
        if (poItem) {
          const updatedReceived = Number(poItem.received_quantity || 0) + item.received_paid_quantity;
          localMutate({
            table: 'purchase_order_items',
            operation: 'UPDATE',
            data: {
              _local_id: poItem._local_id || poItem.id,
              received_quantity: updatedReceived,
            },
          });
        }
      }
    }

    // 5. Update PO Status Lifecycle (PARTIALLY_RECEIVED vs RECEIVED)
    if (grn.po_id) {
      const allPoItems: any[] = localDb.prepare('SELECT ordered_quantity, received_quantity FROM purchase_order_items WHERE po_id = ?').all(grn.po_id);
      const totalOrdered = allPoItems.reduce((acc, it) => acc + Number(it.ordered_quantity || 0), 0);
      const totalReceived = allPoItems.reduce((acc, it) => acc + Number(it.received_quantity || 0), 0);

      const newPoStatus = totalReceived >= totalOrdered ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      localMutate({
        table: 'purchase_orders',
        operation: 'UPDATE',
        data: {
          _local_id: grn.po_id,
          status: newPoStatus,
        },
      });
    }

    // 6. Mark GRN as POSTED
    localMutate({
      table: 'goods_receipts',
      operation: 'UPDATE',
      data: {
        _local_id: grn._local_id || grn.id,
        status: 'POSTED',
      },
    });

    return this.getGrnById(grnId, organizationId)!;
  }

  /**
   * Fetch GRN with items and medicine metadata
   */
  static getGrnById(id: string, organizationId: string): GoodsReceipt | null {
    const row: any = localDb
      .prepare(
        `SELECT grn.*, s.name as supplier_name, po.po_number
         FROM goods_receipts grn
         LEFT JOIN suppliers s ON s.id = grn.supplier_id OR s._local_id = grn.supplier_id
         LEFT JOIN purchase_orders po ON po.id = grn.po_id OR po._local_id = grn.po_id
         WHERE (grn.id = ? OR grn._local_id = ?) AND (grn.organization_id = ?) AND grn._deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const items: any[] = localDb
      .prepare(
        `SELECT gri.*, m.name as medicine_name
         FROM goods_receipt_items gri
         LEFT JOIN medicines m ON m.id = gri.medicine_id OR m._local_id = gri.medicine_id
         WHERE (gri.grn_id = ? OR gri.grn_id = ?) AND gri._deleted = 0`
      )
      .all(row.id, row._local_id || row.id);

    return {
      ...row,
      items,
    } as GoodsReceipt;
  }

  /**
   * List Goods Receipts with filters
   */
  static listGoodsReceipts(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId?: string | null;
    poId?: string | null;
    status?: GoodsReceiptStatus;
    limit?: number;
    offset?: number;
  }): { data: GoodsReceipt[]; total: number } {
    const { organizationId, storeId, supplierId, poId, status, limit = 50, offset = 0 } = params;

    let query = `
      SELECT grn.*, s.name as supplier_name, po.po_number
      FROM goods_receipts grn
      LEFT JOIN suppliers s ON s.id = grn.supplier_id OR s._local_id = grn.supplier_id
      LEFT JOIN purchase_orders po ON po.id = grn.po_id OR po._local_id = grn.po_id
      WHERE (grn.organization_id = ?) AND grn._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (storeId) {
      query += ` AND grn.store_id = ?`;
      values.push(storeId);
    }
    if (supplierId) {
      query += ` AND (grn.supplier_id = ? OR grn.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }
    if (poId) {
      query += ` AND (grn.po_id = ? OR grn.po_id = ?)`;
      values.push(poId, poId);
    }
    if (status) {
      query += ` AND grn.status = ?`;
      values.push(status);
    }

    const countRow: any = localDb.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...values);
    const total = Number(countRow?.total || 0);

    query += ` ORDER BY grn.received_at DESC, grn.created_at DESC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const rows: any[] = localDb.prepare(query).all(...values);
    const data = rows.map(r => this.getGrnById(r.id, organizationId)!);

    return { data, total };
  }
}
