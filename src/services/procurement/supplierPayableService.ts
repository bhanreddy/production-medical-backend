// supplierPayableService.ts — Transaction-Level Payable Ledger, FIFO Payment Allocation & Ageing Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  SupplierPayableLedgerEntry,
  SupplierPayment,
  SupplierLedgerTransactionType,
  PaymentMode,
} from '../../domain/procurementTypes';
import { DocumentNumberingService } from '../documentNumbering';

export class SupplierPayableService {
  /**
   * Record transaction in immutable supplier payable ledger
   */
  static recordLedgerEntry(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId: string;
    transactionType: SupplierLedgerTransactionType;
    referenceId: string;
    referenceNumber?: string | null;
    invoiceId?: string | null;
    debitPaise: number; // Reduces liability (e.g. payment, debit note)
    creditPaise: number; // Increases liability (e.g. purchase invoice)
    notes?: string | null;
    performedBy: string;
  }): SupplierPayableLedgerEntry {
    const {
      organizationId,
      storeId = null,
      supplierId,
      transactionType,
      referenceId,
      referenceNumber = null,
      invoiceId = null,
      debitPaise,
      creditPaise,
      notes = null,
      performedBy,
    } = params;

    // Fetch supplier current balance
    const supplier: any = localDb
      .prepare(
        `SELECT id, _local_id, outstanding_balance FROM suppliers
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) LIMIT 1`
      )
      .get(supplierId, supplierId, organizationId);

    const currentBalancePaise = supplier?.outstanding_balance ? Money.toPaise(Number(supplier.outstanding_balance)) : 0;
    // New Balance = Current + Credit - Debit
    const newBalancePaise = Math.max(0, currentBalancePaise + creditPaise - debitPaise);
    const newBalanceRs = Money.toRupees(newBalancePaise);

    const entryId = uuidv4();
    const nowIso = new Date().toISOString();

    const entry = localMutate({
      table: 'supplier_payable_ledger',
      operation: 'INSERT',
      data: {
        id: entryId,
        _local_id: entryId,
        organization_id: organizationId,
        store_id: storeId,
        supplier_id: supplierId,
        transaction_type: transactionType,
        reference_id: referenceId,
        reference_number: referenceNumber,
        invoice_id: invoiceId,
        debit_paise: debitPaise,
        credit_paise: creditPaise,
        balance_after_paise: newBalancePaise,
        notes,
        performed_by: performedBy,
        created_at: nowIso,
      },
    });

    // Update supplier master outstanding balance
    if (supplier) {
      localMutate({
        table: 'suppliers',
        operation: 'UPDATE',
        data: {
          _local_id: supplier._local_id || supplier.id,
          outstanding_balance: newBalanceRs,
        },
      });
    }

    return entry as any;
  }

  /**
   * Record Supplier Payment with manual or automatic FIFO invoice allocation
   */
  static recordPayment(params: {
    organizationId: string;
    storeId?: string | null;
    supplierId: string;
    paymentDate: string;
    paymentMode: PaymentMode;
    referenceNumber?: string | null;
    amountPaise: number;
    notes?: string | null;
    recordedBy: string;
    allocations?: Array<{
      invoiceId: string;
      amountPaise: number;
    }>;
  }): SupplierPayment {
    const {
      organizationId,
      storeId = null,
      supplierId,
      paymentDate,
      paymentMode,
      referenceNumber = null,
      amountPaise,
      notes = null,
      recordedBy,
      allocations,
    } = params;

    if (amountPaise <= 0) {
      throw new Error('Payment amount must be greater than zero');
    }

    const paymentId = uuidv4();
    const paymentNumber = DocumentNumberingService.generate({
      organizationId,
      storeId,
      documentType: 'SUPPLIER_PAYMENT',
    });

    const nowIso = new Date().toISOString();
    let remainingAmountToAllocate = amountPaise;
    const recordedAllocations: any[] = [];

    // 1. If explicit manual allocations provided
    if (allocations && allocations.length > 0) {
      for (const alloc of allocations) {
        if (remainingAmountToAllocate <= 0) break;
        const allocAmount = Math.min(alloc.amountPaise, remainingAmountToAllocate);

        const invoice: any = localDb.prepare('SELECT * FROM purchase_invoices WHERE id = ? OR _local_id = ?').get(alloc.invoiceId, alloc.invoiceId);
        if (invoice) {
          const invPaid = Number(invoice.paid_amount_paise || 0) + allocAmount;
          const invBalance = Math.max(0, Number(invoice.total_paise || 0) - invPaid);
          const newStatus = invBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID';

          localMutate({
            table: 'purchase_invoices',
            operation: 'UPDATE',
            data: {
              _local_id: invoice._local_id || invoice.id,
              paid_amount_paise: invPaid,
              balance_due_paise: invBalance,
              payment_status: newStatus,
            },
          });

          const allocRec = localMutate({
            table: 'supplier_payment_allocations',
            operation: 'INSERT',
            data: {
              id: uuidv4(),
              payment_id: paymentId,
              invoice_id: invoice.id,
              allocated_amount_paise: allocAmount,
              created_at: nowIso,
            },
          });
          recordedAllocations.push(allocRec);
          remainingAmountToAllocate -= allocAmount;
        }
      }
    } else {
      // 2. Automatic FIFO allocation across oldest unpaid invoices
      const unpaidInvoices: any[] = localDb
        .prepare(
          `SELECT * FROM purchase_invoices
           WHERE (organization_id = ?)
             AND (supplier_id = ? OR supplier_id = ?)
             AND payment_status != 'PAID' AND status = 'POSTED' AND _deleted = 0
           ORDER BY invoice_date ASC, created_at ASC`
        )
        .all(organizationId, supplierId, supplierId);

      for (const inv of unpaidInvoices) {
        if (remainingAmountToAllocate <= 0) break;
        const duePaise = Number(inv.balance_due_paise || inv.total_paise || 0);
        const allocAmount = Math.min(duePaise, remainingAmountToAllocate);

        const newPaid = Number(inv.paid_amount_paise || 0) + allocAmount;
        const newBalance = Math.max(0, Number(inv.total_paise || 0) - newPaid);
        const newStatus = newBalance <= 0 ? 'PAID' : 'PARTIALLY_PAID';

        localMutate({
          table: 'purchase_invoices',
          operation: 'UPDATE',
          data: {
            _local_id: inv._local_id || inv.id,
            paid_amount_paise: newPaid,
            balance_due_paise: newBalance,
            payment_status: newStatus,
          },
        });

        const allocRec = localMutate({
          table: 'supplier_payment_allocations',
          operation: 'INSERT',
          data: {
            id: uuidv4(),
            payment_id: paymentId,
            invoice_id: inv.id,
            allocated_amount_paise: allocAmount,
            created_at: nowIso,
          },
        });
        recordedAllocations.push(allocRec);
        remainingAmountToAllocate -= allocAmount;
      }
    }

    // 3. Create Payment Header
    const paymentHeader = localMutate({
      table: 'supplier_payments',
      operation: 'INSERT',
      data: {
        id: paymentId,
        _local_id: paymentId,
        organization_id: organizationId,
        store_id: storeId,
        supplier_id: supplierId,
        payment_number: paymentNumber,
        payment_date: paymentDate,
        payment_mode: paymentMode,
        reference_number: referenceNumber,
        amount_paise: amountPaise,
        unallocated_paise: remainingAmountToAllocate,
        notes,
        recorded_by: recordedBy,
        created_at: nowIso,
      },
    });

    // 4. Record Supplier Payable Ledger Entry (Debit = Redirection of Liability)
    this.recordLedgerEntry({
      organizationId,
      storeId,
      supplierId,
      transactionType: 'PAYMENT',
      referenceId: paymentId,
      referenceNumber: paymentNumber,
      debitPaise: amountPaise,
      creditPaise: 0,
      notes: `Supplier Payment ${paymentNumber} via ${paymentMode}${referenceNumber ? ` (Ref: ${referenceNumber})` : ''}`,
      performedBy: recordedBy,
    });

    return {
      ...paymentHeader,
      allocations: recordedAllocations,
    } as any;
  }

  /**
   * Get Supplier Ageing Breakdown (CURRENT, 1-30, 31-60, 61-90, 90+ days)
   */
  static getSupplierAgeing(params: {
    organizationId: string;
    supplierId?: string;
    asOfDate?: Date;
  }): Array<{
    supplierId: string;
    supplierName: string;
    currentPaise: number;
    days1_30Paise: number;
    days31_60Paise: number;
    days61_90Paise: number;
    days90PlusPaise: number;
    totalOutstandingPaise: number;
  }> {
    const { organizationId, supplierId, asOfDate = new Date() } = params;

    let query = `
      SELECT pinv.*, sup.name as supplier_name
      FROM purchase_invoices pinv
      JOIN suppliers sup ON sup.id = pinv.supplier_id OR sup._local_id = pinv.supplier_id
      WHERE (pinv.organization_id = ?)
        AND pinv.payment_status != 'PAID' AND pinv.status = 'POSTED' AND pinv._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (supplierId) {
      query += ` AND (pinv.supplier_id = ? OR pinv.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }

    const invoices: any[] = localDb.prepare(query).all(...values);
    const supplierMap = new Map<string, {
      supplierId: string;
      supplierName: string;
      currentPaise: number;
      days1_30Paise: number;
      days31_60Paise: number;
      days61_90Paise: number;
      days90PlusPaise: number;
      totalOutstandingPaise: number;
    }>();

    for (const inv of invoices) {
      const dueDt = new Date(inv.due_date || inv.invoice_date);
      const diffMs = asOfDate.getTime() - dueDt.getTime();
      const overdueDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const balancePaise = Number(inv.balance_due_paise || inv.total_paise || 0);

      let entry = supplierMap.get(inv.supplier_id);
      if (!entry) {
        entry = {
          supplierId: inv.supplier_id,
          supplierName: inv.supplier_name,
          currentPaise: 0,
          days1_30Paise: 0,
          days31_60Paise: 0,
          days61_90Paise: 0,
          days90PlusPaise: 0,
          totalOutstandingPaise: 0,
        };
        supplierMap.set(inv.supplier_id, entry);
      }

      entry.totalOutstandingPaise += balancePaise;

      if (overdueDays <= 0) {
        entry.currentPaise += balancePaise;
      } else if (overdueDays <= 30) {
        entry.days1_30Paise += balancePaise;
      } else if (overdueDays <= 60) {
        entry.days31_60Paise += balancePaise;
      } else if (overdueDays <= 90) {
        entry.days61_90Paise += balancePaise;
      } else {
        entry.days90PlusPaise += balancePaise;
      }
    }

    return Array.from(supplierMap.values());
  }

  /**
   * Get Supplier Ledger Statement
   */
  static getLedgerStatement(params: {
    organizationId: string;
    supplierId: string;
    limit?: number;
    offset?: number;
  }): { data: SupplierPayableLedgerEntry[]; total: number } {
    const { organizationId, supplierId, limit = 50, offset = 0 } = params;

    const countRow: any = localDb
      .prepare(
        `SELECT COUNT(*) as total FROM supplier_payable_ledger
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?) AND _deleted = 0`
      )
      .get(organizationId, supplierId, supplierId);

    const total = Number(countRow?.total || 0);

    const rows: any[] = localDb
      .prepare(
        `SELECT spl.*, s.name as supplier_name
         FROM supplier_payable_ledger spl
         LEFT JOIN suppliers s ON s.id = spl.supplier_id OR s._local_id = spl.supplier_id
         WHERE (spl.organization_id = ?)
           AND (spl.supplier_id = ? OR spl.supplier_id = ?) AND spl._deleted = 0
         ORDER BY spl.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(organizationId, supplierId, supplierId, limit, offset);

    return { data: rows, total };
  }
}
