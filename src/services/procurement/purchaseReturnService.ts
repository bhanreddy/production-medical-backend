// purchaseReturnService.ts — Enterprise Purchase Return & Statutory Debit Note Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  PurchaseReturnV2,
  PurchaseReturnLineItem,
  DebitNote,
  PurchaseReturnReason,
} from '../../domain/procurementTypes';
import { DocumentNumberingService } from '../documentNumbering';
import { InventoryPositionService } from '../inventoryPosition';
import { SupplierPayableService } from './supplierPayableService';

export interface CreatePurchaseReturnParams {
  organizationId: string;
  storeId?: string | null;
  warehouseId?: string | null;
  supplierId: string;
  grnId?: string | null;
  invoiceId?: string | null;
  reason: PurchaseReturnReason;
  notes?: string | null;
  createdBy: string;
  lines: Array<{
    medicineId: string;
    batchId: string;
    quantity: number;
    ratePaise?: number;
    gstRate?: number;
    notes?: string | null;
  }>;
}

export class PurchaseReturnService {
  /**
   * Create and execute a Purchase Return with Debit Note generation and ledger settlement
   */
  static createPurchaseReturn(params: CreatePurchaseReturnParams): PurchaseReturnV2 {
    const {
      organizationId,
      storeId = null,
      warehouseId = null,
      supplierId,
      grnId = null,
      invoiceId = null,
      reason,
      notes = null,
      createdBy,
      lines,
    } = params;

    if (!lines || lines.length === 0) {
      throw new Error('Purchase return requires at least one line item');
    }

    const returnId = uuidv4();
    const returnNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'PURCHASE_RETURN',
    });

    const debitNoteId = uuidv4();
    const debitNoteNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'DEBIT_NOTE',
    });

    const nowIso = new Date().toISOString();
    const locationType = warehouseId ? 'WAREHOUSE' : 'STORE';

    let totalValuePaise = 0;
    let totalGstPaise = 0;
    const processedLines: PurchaseReturnLineItem[] = [];

    // Process each return line item: check batch stock, reduce stock, write ledger
    for (const ln of lines) {
      const batch: any = localDb
        .prepare(
          `SELECT mb.*, m.name as medicine_name
           FROM medicine_batches mb
           JOIN medicines m ON m.id = mb.medicine_id OR m._local_id = mb.medicine_id
           WHERE (mb.id = ? OR mb._local_id = ?) AND (mb.organization_id = ?)`
        )
        .get(ln.batchId, ln.batchId, organizationId);

      if (!batch) {
        throw new Error(`Batch ID ${ln.batchId} not found in inventory`);
      }

      const onHand = Number(batch.quantity_remaining || 0);
      if (onHand < ln.quantity) {
        throw new Error(`Insufficient stock for batch ${batch.batch_number} (Available: ${onHand}, Requested Return: ${ln.quantity})`);
      }

      const ratePaise = ln.ratePaise !== undefined ? ln.ratePaise : (batch.cost_price_paise || Money.toPaise(Number(batch.purchase_price || 0)));
      const gstRate = ln.gstRate !== undefined ? ln.gstRate : 12.0;

      const lineGrossPaise = ratePaise * ln.quantity;
      const lineGstPaise = Math.round((lineGrossPaise * gstRate) / 100);
      const lineTotalPaise = lineGrossPaise + lineGstPaise;

      totalValuePaise += lineGrossPaise;
      totalGstPaise += lineGstPaise;

      const newBatchRemaining = onHand - ln.quantity;

      // 1. Reduce Batch Stock
      localMutate({
        table: 'medicine_batches',
        operation: 'UPDATE',
        data: {
          _local_id: batch._local_id || batch.id,
          quantity_remaining: newBatchRemaining,
        },
      });

      // 2. Adjust Multi-State Inventory Position
      try {
        InventoryPositionService.adjustStock({
          organizationId,
          medicineId: batch.medicine_id,
          batchId: batch.id || batch._local_id,
          locationType,
          storeId,
          warehouseId,
          quantityDelta: -ln.quantity,
        });
      } catch {}

      // 3. Append Immutable Stock Ledger Movement
      localMutate({
        table: 'stock_ledger',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          _local_id: uuidv4(),
          organization_id: organizationId,
          store_id: storeId,
          warehouse_id: warehouseId,
          medicine_id: batch.medicine_id,
          batch_id: batch.id,
          movement_type: 'PURCHASE_RETURN',
          quantity_delta: -ln.quantity,
          balance_after: newBatchRemaining,
          reference_id: returnId,
          notes: `Purchase Return ${returnNumber} (${reason}): Returned ${ln.quantity} units to supplier`,
          performed_by: createdBy,
        },
      });

      // 4. Save Return Line Record
      const lineRecord = localMutate({
        table: 'purchase_return_lines',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          _local_id: uuidv4(),
          clinic_id: 'default-clinic',
          return_id: returnId,
          batch_id: batch.id,
          medicine_id: batch.medicine_id,
          quantity: ln.quantity,
          rate: Money.toRupees(ratePaise),
        },
      });

      processedLines.push({
        id: lineRecord.id,
        return_id: returnId,
        medicine_id: batch.medicine_id,
        medicine_name: batch.medicine_name,
        batch_id: batch.id,
        batch_number: batch.batch_number,
        quantity: ln.quantity,
        rate_paise: ratePaise,
        gst_rate: gstRate,
        total_paise: lineTotalPaise,
        notes: ln.notes || null,
      });
    }

    const netGrandTotalPaise = totalValuePaise + totalGstPaise;

    // 5. Create Purchase Return Document Header
    const returnHeader = localMutate({
      table: 'purchase_returns',
      operation: 'INSERT',
      data: {
        id: returnId,
        _local_id: returnId,
        organization_id: organizationId,
        store_id: storeId,
        warehouse_id: warehouseId,
        supplier_id: supplierId,
        return_number: returnNumber,
        grn_id: grnId,
        invoice_id: invoiceId,
        reason,
        status: 'POSTED',
        total_value: Money.toRupees(netGrandTotalPaise),
        total_value_paise: totalValuePaise,
        gst_paise: totalGstPaise,
        debit_note_id: debitNoteId,
        created_by: createdBy,
        posted_at: nowIso,
      },
    });

    // 6. Generate Statutory Debit Note
    localMutate({
      table: 'debit_notes',
      operation: 'INSERT',
      data: {
        id: debitNoteId,
        _local_id: debitNoteId,
        organization_id: organizationId,
        store_id: storeId,
        supplier_id: supplierId,
        debit_note_number: debitNoteNumber,
        return_id: returnId,
        invoice_id: invoiceId,
        amount_paise: totalValuePaise,
        gst_paise: totalGstPaise,
        status: 'ISSUED',
        issued_at: nowIso,
        created_by: createdBy,
      },
    });

    // 7. Record DEBIT_NOTE in Supplier Payable Ledger (Reduces Liability)
    SupplierPayableService.recordLedgerEntry({
      organizationId,
      storeId,
      supplierId,
      transactionType: 'DEBIT_NOTE',
      referenceId: debitNoteId,
      referenceNumber: debitNoteNumber,
      invoiceId,
      debitPaise: netGrandTotalPaise,
      creditPaise: 0,
      notes: `Debit Note ${debitNoteNumber} for Purchase Return ${returnNumber} (${reason})`,
      performedBy: createdBy,
    });

    return {
      ...returnHeader,
      lines: processedLines,
    } as any;
  }

  /**
   * Fetch Purchase Return by ID
   */
  static getPurchaseReturnById(id: string, organizationId: string): PurchaseReturnV2 | null {
    const row: any = localDb
      .prepare(
        `SELECT pr.*, sup.name as supplier_name, dn.debit_note_number
         FROM purchase_returns pr
         LEFT JOIN suppliers sup ON sup.id = pr.supplier_id OR sup._local_id = pr.supplier_id
         LEFT JOIN debit_notes dn ON dn.id = pr.debit_note_id OR dn.return_id = pr.id
         WHERE (pr.id = ? OR pr._local_id = ?) AND (pr.organization_id = ?) AND pr._deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const lines: any[] = localDb
      .prepare(
        `SELECT prl.*, mb.batch_number, m.name as medicine_name
         FROM purchase_return_lines prl
         LEFT JOIN medicine_batches mb ON mb.id = prl.batch_id OR mb._local_id = prl.batch_id
         LEFT JOIN medicines m ON m.id = prl.medicine_id OR m._local_id = prl.medicine_id
         WHERE prl.return_id = ? OR prl.return_id = ?`
      )
      .all(row.id, row._local_id || row.id);

    return {
      ...row,
      lines,
    } as PurchaseReturnV2;
  }

  /**
   * List Purchase Returns
   */
  static listPurchaseReturns(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId?: string | null;
    limit?: number;
    offset?: number;
  }): { data: PurchaseReturnV2[]; total: number } {
    const { organizationId, storeId, supplierId, limit = 50, offset = 0 } = params;

    let query = `
      SELECT pr.*, sup.name as supplier_name
      FROM purchase_returns pr
      LEFT JOIN suppliers sup ON sup.id = pr.supplier_id OR sup._local_id = pr.supplier_id
      WHERE (pr.organization_id = ?) AND pr._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (storeId) {
      query += ` AND pr.store_id = ?`;
      values.push(storeId);
    }
    if (supplierId) {
      query += ` AND (pr.supplier_id = ? OR pr.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }

    const countRow: any = localDb.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...values);
    const total = Number(countRow?.total || 0);

    query += ` ORDER BY pr.created_at DESC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const rows: any[] = localDb.prepare(query).all(...values);
    const data = rows.map(r => this.getPurchaseReturnById(r.id, organizationId)!);

    return { data, total };
  }

  /**
   * List Debit Notes
   */
  static listDebitNotes(params: {
    organizationId: string;
    supplierId?: string;
  }): DebitNote[] {
    const { organizationId, supplierId } = params;
    let query = `
      SELECT dn.*, sup.name as supplier_name
      FROM debit_notes dn
      LEFT JOIN suppliers sup ON sup.id = dn.supplier_id OR sup._local_id = dn.supplier_id
      WHERE (dn.organization_id = ?) AND dn._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (supplierId) {
      query += ` AND (dn.supplier_id = ? OR dn.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }

    query += ` ORDER BY dn.issued_at DESC`;
    return localDb.prepare(query).all(...values) as DebitNote[];
  }
}
