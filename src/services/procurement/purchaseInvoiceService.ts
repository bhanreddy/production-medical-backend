// purchaseInvoiceService.ts — Enterprise Purchase Invoice, OCR Draft, 3-Way Match Posting & Liability Creation Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  PurchaseInvoice,
  PurchaseInvoiceItem,
  ThreeWayMatchStatus,
} from '../../domain/procurementTypes';
import { ThreeWayMatchingService } from './threeWayMatchingService';
import { SupplierPayableService } from './supplierPayableService';
import { SupplierCatalogService } from './supplierCatalogService';

export interface CreatePurchaseInvoiceParams {
  organizationId: string;
  storeId?: string | null;
  warehouseId?: string | null;
  supplierId: string;
  poId?: string | null;
  grnId?: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  paymentTerms?: string;
  notes?: string | null;
  billImageUrl?: string | null;
  ocrExtractedJson?: any;
  createdBy: string;
  items: Array<{
    poItemId?: string | null;
    grnItemId?: string | null;
    medicineId: string;
    batchNumber?: string;
    quantity: number;
    freeQuantity?: number;
    purchaseRatePaise: number;
    discountPct?: number;
    gstRate?: number;
    varianceNotes?: string | null;
  }>;
}

export class PurchaseInvoiceService {
  /**
   * Create a draft Purchase Invoice and run initial Three-Way Match evaluation
   */
  static createInvoice(params: CreatePurchaseInvoiceParams): PurchaseInvoice {
    const {
      organizationId,
      storeId = null,
      warehouseId = null,
      supplierId,
      poId = null,
      grnId = null,
      invoiceNumber,
      invoiceDate,
      dueDate = null,
      paymentTerms = 'NET_30',
      notes = null,
      billImageUrl = null,
      ocrExtractedJson = null,
      createdBy,
      items,
    } = params;

    if (!items || items.length === 0) {
      throw new Error('Invoice must contain at least one item');
    }

    // Duplicate Supplier Invoice Check (organization + supplier + invoice_number)
    const existing: any = localDb
      .prepare(
        `SELECT id, invoice_number, status FROM purchase_invoices
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?)
           AND invoice_number = ?
           AND _deleted = 0 LIMIT 1`
      )
      .get(organizationId, supplierId, supplierId, invoiceNumber);

    if (existing) {
      throw new Error(`Duplicate Supplier Invoice: Invoice #${invoiceNumber} already exists for this supplier (Status: ${existing.status})`);
    }

    const invoiceId = uuidv4();
    let subtotalPaise = 0;
    let discountPaise = 0;
    let gstPaise = 0;
    const invItemRecords: any[] = [];

    for (const it of items) {
      const itemId = uuidv4();
      const discPct = it.discountPct || 0;
      const gstRate = it.gstRate !== undefined ? it.gstRate : 12.0;

      const lineGrossPaise = it.purchaseRatePaise * it.quantity;
      const lineDiscAmtPaise = Math.round((lineGrossPaise * discPct) / 100);
      const lineTaxablePaise = lineGrossPaise - lineDiscAmtPaise;
      const lineGstPaise = Math.round((lineTaxablePaise * gstRate) / 100);
      const lineTotalPaise = lineTaxablePaise + lineGstPaise;

      subtotalPaise += lineGrossPaise;
      discountPaise += lineDiscAmtPaise;
      gstPaise += lineGstPaise;

      const itemRecord = localMutate({
        table: 'purchase_invoice_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          invoice_id: invoiceId,
          organization_id: organizationId,
          po_item_id: it.poItemId || null,
          grn_item_id: it.grnItemId || null,
          medicine_id: it.medicineId,
          batch_number: it.batchNumber || null,
          quantity: it.quantity,
          free_quantity: it.freeQuantity || 0,
          purchase_rate_paise: it.purchaseRatePaise,
          discount_pct: discPct,
          gst_rate: gstRate,
          total_paise: lineTotalPaise,
          match_status: 'MATCHED',
          variance_notes: it.varianceNotes || null,
        },
      });

      invItemRecords.push({
        ...itemRecord,
        poItemId: it.poItemId,
        grnItemId: it.grnItemId,
        medicineId: it.medicineId,
        quantity: it.quantity,
        freeQuantity: it.freeQuantity,
        purchaseRatePaise: it.purchaseRatePaise,
        discountPct: discPct,
        gstRate,
        totalPaise: lineTotalPaise,
      });
    }

    const totalPaise = subtotalPaise - discountPaise + gstPaise;

    // Calculate Due Date based on Payment Terms if not provided
    let calculatedDueDate = dueDate;
    if (!calculatedDueDate && invoiceDate) {
      const invDt = new Date(invoiceDate);
      let daysToAdd = 30;
      if (paymentTerms === 'NET_15') daysToAdd = 15;
      else if (paymentTerms === 'NET_45') daysToAdd = 45;
      else if (paymentTerms === 'NET_60') daysToAdd = 60;
      else if (paymentTerms === 'IMMEDIATE') daysToAdd = 0;

      invDt.setDate(invDt.getDate() + daysToAdd);
      calculatedDueDate = invDt.toISOString().slice(0, 10);
    }

    // Run Initial Three-Way Match Engine
    const matchResult = ThreeWayMatchingService.evaluateThreeWayMatch({
      organizationId,
      invoiceId,
      poId,
      grnId,
      invoiceLines: invItemRecords,
    });

    const invoiceHeader = localMutate({
      table: 'purchase_invoices',
      operation: 'INSERT',
      data: {
        id: invoiceId,
        _local_id: invoiceId,
        organization_id: organizationId,
        store_id: storeId,
        warehouse_id: warehouseId,
        supplier_id: supplierId,
        po_id: poId,
        grn_id: grnId,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        due_date: calculatedDueDate,
        payment_terms: paymentTerms,
        subtotal_paise: subtotalPaise,
        discount_paise: discountPaise,
        gst_paise: gstPaise,
        round_off_paise: 0,
        total_paise: totalPaise,
        paid_amount_paise: 0,
        balance_due_paise: totalPaise,
        payment_status: 'UNPAID',
        match_status: matchResult.match_status,
        status: matchResult.match_status === 'MATCHED' ? 'MATCHED' : 'DRAFT',
        notes,
        bill_image_url: billImageUrl,
        ocr_extracted_json: ocrExtractedJson ? JSON.stringify(ocrExtractedJson) : null,
        created_by: createdBy,
      },
    });

    return this.getInvoiceById(invoiceId, organizationId)!;
  }

  /**
   * Post Purchase Invoice:
   * - Validates 3-way match or approved exception
   * - Creates financial liability in Supplier Payable Ledger
   * - Updates supplier outstanding balance
   * - Records supplier rate observation in price history
   * - CRITICAL: Does NOT increment physical stock (stock was added on GRN posting)
   */
  static postInvoice(params: {
    invoiceId: string;
    organizationId: string;
    postedBy: string;
  }): PurchaseInvoice {
    const { invoiceId, organizationId, postedBy } = params;
    const invoice = this.getInvoiceById(invoiceId, organizationId);
    if (!invoice) throw new Error('Purchase Invoice not found');

    if (invoice.status === 'POSTED') {
      return invoice; // Idempotent
    }

    if (invoice.status === 'CANCELLED') {
      throw new Error('Cannot post a cancelled invoice');
    }

    // Require 3-way match or exception approval before posting
    if (invoice.match_status !== 'MATCHED') {
      const matchRow: any = localDb.prepare('SELECT * FROM purchase_match_results WHERE invoice_id = ?').get(invoice.id);
      if (!matchRow || matchRow.is_exception) {
        throw new Error(`Cannot post invoice with unmatched variance: ${invoice.match_status}. Supervisor exception approval required.`);
      }
    }

    const nowIso = new Date().toISOString();

    // 1. Create Supplier Payable Ledger Entry (Increases Liability)
    SupplierPayableService.recordLedgerEntry({
      organizationId,
      storeId: invoice.store_id || null,
      supplierId: invoice.supplier_id,
      transactionType: 'PURCHASE_INVOICE',
      referenceId: invoice.id,
      referenceNumber: invoice.invoice_number,
      invoiceId: invoice.id,
      debitPaise: 0,
      creditPaise: invoice.total_paise,
      notes: `Purchase Invoice #${invoice.invoice_number} posted (Due: ${invoice.due_date || 'N/A'})`,
      performedBy: postedBy,
    });

    // 2. Record Price Observations in History
    for (const it of invoice.items || []) {
      SupplierCatalogService.recordPriceHistory({
        organizationId,
        supplierId: invoice.supplier_id,
        medicineId: it.medicine_id,
        ratePaise: it.purchase_rate_paise,
        effectiveCostPaise: Math.round(it.total_paise / (it.quantity + (it.free_quantity || 0))),
        sourceType: 'PURCHASE_INVOICE',
        referenceId: invoice.id,
        observedAt: new Date(invoice.invoice_date),
      });
    }

    // 3. Mark Invoice as POSTED
    localMutate({
      table: 'purchase_invoices',
      operation: 'UPDATE',
      data: {
        _local_id: invoice._local_id || invoice.id,
        status: 'POSTED',
        posted_by: postedBy,
        posted_at: nowIso,
      },
    });

    return this.getInvoiceById(invoiceId, organizationId)!;
  }

  /**
   * Fetch invoice with line items, match results, and supplier metadata
   */
  static getInvoiceById(id: string, organizationId: string): PurchaseInvoice | null {
    const row: any = localDb
      .prepare(
        `SELECT pinv.*, s.name as supplier_name
         FROM purchase_invoices pinv
         LEFT JOIN suppliers s ON s.id = pinv.supplier_id OR s._local_id = pinv.supplier_id
         WHERE (pinv.id = ? OR pinv._local_id = ?) AND (pinv.organization_id = ?) AND pinv._deleted = 0`
      )
      .get(id, id, organizationId);

    if (!row) return null;

    const items: any[] = localDb
      .prepare(
        `SELECT pii.*, m.name as medicine_name
         FROM purchase_invoice_items pii
         LEFT JOIN medicines m ON m.id = pii.medicine_id OR m._local_id = pii.medicine_id
         WHERE (pii.invoice_id = ? OR pii.invoice_id = ?) AND pii._deleted = 0`
      )
      .all(row.id, row._local_id || row.id);

    const matchResult: any = localDb
      .prepare(`SELECT * FROM purchase_match_results WHERE invoice_id = ? OR invoice_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(row.id, row._local_id || row.id);

    return {
      ...row,
      items,
      match_result: matchResult || undefined,
    } as PurchaseInvoice;
  }

  /**
   * List purchase invoices with filters
   */
  static listInvoices(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId?: string | null;
    status?: string;
    paymentStatus?: string;
    limit?: number;
    offset?: number;
  }): { data: PurchaseInvoice[]; total: number } {
    const { organizationId, storeId, supplierId, status, paymentStatus, limit = 50, offset = 0 } = params;

    let query = `
      SELECT pinv.*, s.name as supplier_name
      FROM purchase_invoices pinv
      LEFT JOIN suppliers s ON s.id = pinv.supplier_id OR s._local_id = pinv.supplier_id
      WHERE (pinv.organization_id = ?) AND pinv._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (storeId) {
      query += ` AND pinv.store_id = ?`;
      values.push(storeId);
    }
    if (supplierId) {
      query += ` AND (pinv.supplier_id = ? OR pinv.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }
    if (status) {
      query += ` AND pinv.status = ?`;
      values.push(status);
    }
    if (paymentStatus) {
      query += ` AND pinv.payment_status = ?`;
      values.push(paymentStatus);
    }

    const countRow: any = localDb.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...values);
    const total = Number(countRow?.total || 0);

    query += ` ORDER BY pinv.invoice_date DESC, pinv.created_at DESC LIMIT ? OFFSET ?`;
    values.push(limit, offset);

    const rows: any[] = localDb.prepare(query).all(...values);
    const data = rows.map(r => this.getInvoiceById(r.id, organizationId)!);

    return { data, total };
  }
}
