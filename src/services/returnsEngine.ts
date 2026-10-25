import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { Money } from '../lib/money';
import { v4 as uuidv4 } from 'uuid';
import { DocumentNumberingService } from './documentNumbering';
import { InventoryPositionService } from './inventoryPosition';
import { LoyaltyEngine } from './commercial/loyaltyEngine';
import { AppError } from '../lib/appError';

export type ReturnReasonCode =
  | 'CUSTOMER_RETURN'
  | 'WRONG_ITEM'
  | 'DAMAGED'
  | 'BILLING_ERROR'
  | 'QUALITY_ISSUE'
  | 'OTHER';

export type RefundMethod =
  | 'CASH'
  | 'UPI'
  | 'CARD'
  | 'STORE_CREDIT'
  | 'ORIGINAL_TENDER';

export interface ReturnItemInput {
  sale_item_id: string;
  quantity: number;
  reason_code: ReturnReasonCode;
  notes?: string;
}

export interface ProcessReturnParams {
  originalSaleId: string;
  items: ReturnItemInput[];
  refundMethod: RefundMethod;
  refundReference?: string;
  organizationId: string;
  storeId: string;
  counterId?: string | null;
  terminalId?: string | null;
  performedBy: string;
  supervisorAuthId?: string;
}

export class ReturnsEngine {
  /**
   * Generates a return quote and validates eligibility referencing original commercial snapshot
   */
  static quoteReturn(params: { originalSaleId: string; items: ReturnItemInput[] }) {
    const { originalSaleId, items } = params;

    const origSale: any = localDb
      .prepare('SELECT * FROM sales WHERE id = ? OR _local_id = ?')
      .get(originalSaleId, originalSaleId);

    if (!origSale) {
      throw new AppError(404, 'Original invoice not found', 'ORIGINAL_SALE_NOT_FOUND');
    }

    // Fetch original commercial snapshot if present
    const commercialSnapshot: any = localDb
      .prepare('SELECT * FROM sale_commercial_snapshots WHERE sale_id = ?')
      .get(origSale.id || origSale._local_id);

    const quoteLines: any[] = [];
    let totalRefundPaise = 0;

    for (const retItem of items) {
      const origItem: any = localDb
        .prepare('SELECT * FROM sale_items WHERE (id = ? OR _local_id = ?) AND sale_id = ?')
        .get(retItem.sale_item_id, retItem.sale_item_id, origSale.id || origSale._local_id);

      if (!origItem) {
        throw new AppError(404, `Sale item ${retItem.sale_item_id} not found in invoice`, 'SALE_ITEM_NOT_FOUND');
      }

      if (retItem.quantity <= 0) {
        throw new AppError(400, 'Return quantity must be > 0', 'INVALID_RETURN_QUANTITY');
      }

      if (retItem.quantity > origItem.quantity) {
        throw new AppError(
          400,
          `Return quantity (${retItem.quantity}) cannot exceed purchased quantity (${origItem.quantity})`,
          'RETURN_QUANTITY_EXCEEDS_PURCHASE'
        );
      }

      const unitPrice = Number(origItem.unit_price || 0);
      const discountPct = Number(origItem.discount_pct || 0);
      const effectiveUnitPrice = Money.round(unitPrice * (1 - discountPct / 100));
      const lineRefund = Money.round(effectiveUnitPrice * retItem.quantity);
      const lineRefundPaise = Money.toPaise(lineRefund);

      totalRefundPaise += lineRefundPaise;

      quoteLines.push({
        saleItemId: origItem.id || origItem._local_id,
        medicineId: origItem.medicine_id,
        batchId: origItem.batch_id,
        purchasedQuantity: origItem.quantity,
        returnQuantity: retItem.quantity,
        unitPrice,
        discountPct,
        effectiveUnitPrice,
        lineRefund,
        lineRefundPaise,
        reasonCode: retItem.reason_code,
      });
    }

    const totalRefund = Money.toRupees(totalRefundPaise);

    return {
      originalInvoiceNumber: origSale.invoice_number,
      commercialSnapshot,
      lines: quoteLines,
      totalRefund,
      totalRefundPaise,
    };
  }

  /**
   * Processes a return transaction atomically
   */
  static processReturn(params: ProcessReturnParams) {
    const {
      originalSaleId,
      items,
      refundMethod,
      refundReference,
      organizationId,
      storeId,
      counterId = null,
      terminalId = null,
      performedBy,
    } = params;

    const quote = this.quoteReturn({ originalSaleId, items });
    const origSale: any = localDb
      .prepare('SELECT * FROM sales WHERE id = ? OR _local_id = ?')
      .get(originalSaleId, originalSaleId);

    const now = new Date().toISOString();
    const returnSaleId = uuidv4();

    // 1. Generate Return Invoice Number & Credit Note Number
    const returnDocNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'SALE_RETURN',
    });

    const creditNoteNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'CREDIT_NOTE',
    });

    // 2. Insert Return Sale
    const returnSale = localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: returnSaleId,
        _local_id: returnSaleId,
        organization_id: organizationId,
        store_id: storeId,
        counter_id: counterId,
        terminal_id: terminalId,
        clinic_id: origSale.clinic_id,
        customer_id: origSale.customer_id,
        invoice_number: returnDocNumber,
        credit_note_number: creditNoteNumber,
        subtotal: -quote.totalRefund,
        grand_total: -quote.totalRefund,
        net_amount: -quote.totalRefund,
        paid_amount: -quote.totalRefund,
        balance_due: 0,
        payment_mode: refundMethod.toLowerCase(),
        payment_status: 'returned',
        is_return: 1,
        return_of: origSale.id || origSale._local_id,
        served_by: performedBy,
      },
    });

    // 3. Process Return Items, Inventory Restorations & Stock Ledger
    const returnedItems = [];
    for (const qLine of quote.lines) {
      const returnItemId = uuidv4();
      const itemRecord = localMutate({
        table: 'sale_items',
        operation: 'INSERT',
        data: {
          id: returnItemId,
          _local_id: returnItemId,
          organization_id: organizationId,
          store_id: storeId,
          clinic_id: origSale.clinic_id,
          sale_id: returnSaleId,
          medicine_id: qLine.medicineId,
          batch_id: qLine.batchId,
          quantity: -qLine.returnQuantity,
          unit_price: qLine.unitPrice,
          discount_pct: qLine.discountPct,
          total: -qLine.lineRefund,
          reason: qLine.reasonCode,
          sale_item_id: qLine.saleItemId,
        },
      });
      returnedItems.push(itemRecord);

      // Restore batch stock
      localDb
        .prepare('UPDATE medicine_batches SET quantity_remaining = quantity_remaining + ? WHERE id = ? OR _local_id = ?')
        .run(qLine.returnQuantity, qLine.batchId, qLine.batchId);

      // Restore inventory position
      try {
        InventoryPositionService.adjustStock({
          organizationId,
          medicineId: qLine.medicineId,
          batchId: qLine.batchId,
          locationType: 'STORE',
          storeId,
          quantityDelta: qLine.returnQuantity,
        });
      } catch {
        InventoryPositionService.getOrCreatePosition({
          organizationId,
          medicineId: qLine.medicineId,
          batchId: qLine.batchId,
          locationType: 'STORE',
          storeId,
          initialStock: qLine.returnQuantity,
        });
      }

      // Write Immutable Stock Ledger Movement
      const batchRow: any = localDb
        .prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ? OR _local_id = ?')
        .get(qLine.batchId, qLine.batchId);

      localMutate({
        table: 'stock_ledger',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          organization_id: organizationId,
          store_id: storeId,
          counter_id: counterId,
          terminal_id: terminalId,
          clinic_id: origSale.clinic_id,
          medicine_id: qLine.medicineId,
          batch_id: qLine.batchId,
          movement_type: 'SALE_RETURN',
          quantity_delta: qLine.returnQuantity,
          balance_after: Number(batchRow?.quantity_remaining || 0),
          reference_id: returnSaleId,
          notes: `Return: ${qLine.reasonCode} from invoice ${origSale.invoice_number}`,
          performed_by: performedBy,
        },
      });
    }

    // 4. Record Refund Payment Transaction
    const paymentTxId = uuidv4();
    localMutate({
      table: 'payment_transactions',
      operation: 'INSERT',
      data: {
        id: paymentTxId,
        _local_id: paymentTxId,
        organization_id: organizationId,
        store_id: storeId,
        terminal_id: terminalId,
        sale_id: origSale.id || origSale._local_id,
        return_id: returnSaleId,
        tender_type: refundMethod,
        amount: -quote.totalRefund,
        amount_paise: -quote.totalRefundPaise,
        reference_number: refundReference || creditNoteNumber,
        status: 'REFUNDED',
        provider: 'MANUAL_CONFIRMED',
      },
    });

    // 5. Reverse Loyalty Points Earning & Restore Redeemed Value
    if (origSale.customer_id) {
      const origGrandTotal = Number(origSale.grand_total || origSale.net_amount || 1);
      const returnRatio = origGrandTotal > 0 ? quote.totalRefund / origGrandTotal : 1.0;
      LoyaltyEngine.processReturnReversal({
        organizationId,
        customerId: origSale.customer_id,
        originalSaleId: origSale.id || origSale._local_id,
        returnId: returnSaleId,
        returnRatio,
      });
    }

    return {
      returnSaleId,
      returnInvoiceNumber: returnDocNumber,
      creditNoteNumber,
      totalRefund: quote.totalRefund,
      refundMethod,
      items: returnedItems,
    };
  }
}

