// threeWayMatchingService.ts — Enterprise Three-Way Matching (PO vs GRN vs Invoice) & Variance Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  ThreeWayMatchStatus,
  PurchaseMatchResult,
} from '../../domain/procurementTypes';
import { ProcurementPolicyService } from './procurementPolicyService';

export interface EvaluateMatchParams {
  organizationId: string;
  invoiceId: string;
  poId?: string | null;
  grnId?: string | null;
  invoiceLines: Array<{
    id?: string;
    poItemId?: string | null;
    grnItemId?: string | null;
    medicineId: string;
    quantity: number;
    freeQuantity?: number;
    purchaseRatePaise: number;
    discountPct?: number;
    gstRate?: number;
    totalPaise: number;
  }>;
}

export class ThreeWayMatchingService {
  /**
   * Evaluates Three-Way Match between PO, GRN, and Supplier Invoice
   */
  static evaluateThreeWayMatch(params: EvaluateMatchParams): PurchaseMatchResult {
    const { organizationId, invoiceId, poId, grnId, invoiceLines } = params;
    const policy = ProcurementPolicyService.getPolicy(organizationId);

    // Fetch PO items if poId exists
    const poItemMap = new Map<string, any>();
    if (poId) {
      const poItems: any[] = localDb.prepare('SELECT * FROM purchase_order_items WHERE po_id = ? AND _deleted = 0').all(poId);
      for (const p of poItems) {
        poItemMap.set(p.id, p);
        poItemMap.set(p.medicine_id, p);
      }
    }

    // Fetch GRN items if grnId exists
    const grnItemMap = new Map<string, any>();
    if (grnId) {
      const grnItems: any[] = localDb.prepare('SELECT * FROM goods_receipt_items WHERE grn_id = ? AND _deleted = 0').all(grnId);
      for (const g of grnItems) {
        grnItemMap.set(g.id, g);
        grnItemMap.set(g.medicine_id, g);
      }
    }

    let overallStatus: ThreeWayMatchStatus = 'MATCHED';
    let totalQuantityVariance = 0;
    let totalPriceVariancePaise = 0;
    let maxPriceVariancePct = 0;
    let totalTaxVariancePaise = 0;
    let schemeVarianceSummary: string | null = null;
    let toleranceApplied = false;
    let isException = false;

    const lineDetails: any[] = [];

    for (const invLine of invoiceLines) {
      const poItem = invLine.poItemId ? poItemMap.get(invLine.poItemId) : poItemMap.get(invLine.medicineId);
      const grnItem = invLine.grnItemId ? grnItemMap.get(invLine.grnItemId) : grnItemMap.get(invLine.medicineId);

      let lineMatchStatus: ThreeWayMatchStatus = 'MATCHED';
      let lineVarianceNotes: string[] = [];

      // 1. Unordered item check
      if (poId && !poItem) {
        lineMatchStatus = 'UNORDERED_ITEM';
        lineVarianceNotes.push('Item not found on Purchase Order');
      }

      // 2. Missing GRN check
      if (grnId && !grnItem) {
        lineMatchStatus = 'MISSING_GRN';
        lineVarianceNotes.push('Item not found on Goods Receipt Note');
      }

      // 3. Price variance check (Invoice Rate vs PO Rate)
      if (poItem) {
        const poRatePaise = Number(poItem.purchase_rate_paise || 0);
        const invRatePaise = invLine.purchaseRatePaise;
        const priceDiffPaise = invRatePaise - poRatePaise;

        if (priceDiffPaise !== 0 && poRatePaise > 0) {
          const priceDiffPct = (priceDiffPaise / poRatePaise) * 100;
          totalPriceVariancePaise += priceDiffPaise * invLine.quantity;
          maxPriceVariancePct = Math.max(maxPriceVariancePct, Math.abs(priceDiffPct));

          if (Math.abs(priceDiffPct) > policy.priceVarianceTolerancePct) {
            lineMatchStatus = 'PRICE_VARIANCE';
            lineVarianceNotes.push(`Price variance of ${priceDiffPct.toFixed(2)}% (Invoice: ₹${(invRatePaise / 100).toFixed(2)}, PO: ₹${(poRatePaise / 100).toFixed(2)})`);
          } else {
            toleranceApplied = true;
            lineVarianceNotes.push(`Price variance of ${priceDiffPct.toFixed(2)}% accepted within ${policy.priceVarianceTolerancePct}% tolerance`);
          }
        }
      }

      // 4. Quantity variance check (Invoice Quantity vs GRN Accepted Quantity)
      if (grnItem) {
        const grnAcceptedQty = Number(grnItem.accepted_quantity || 0);
        const invQty = invLine.quantity + (invLine.freeQuantity || 0);
        const qtyDiff = invQty - grnAcceptedQty;

        if (qtyDiff !== 0 && grnAcceptedQty > 0) {
          totalQuantityVariance += qtyDiff;
          const qtyDiffPct = (Math.abs(qtyDiff) / grnAcceptedQty) * 100;

          if (qtyDiffPct > policy.quantityVarianceTolerancePct) {
            lineMatchStatus = 'QUANTITY_VARIANCE';
            lineVarianceNotes.push(`Quantity variance: Invoiced ${invQty} vs GRN Accepted ${grnAcceptedQty} (${qtyDiffPct.toFixed(2)}%)`);
          } else {
            toleranceApplied = true;
            lineVarianceNotes.push(`Quantity variance of ${qtyDiffPct.toFixed(2)}% accepted within ${policy.quantityVarianceTolerancePct}% tolerance`);
          }
        }
      }

      // 5. Tax variance check
      if (poItem && invLine.gstRate !== undefined) {
        const poGst = Number(poItem.gst_rate ?? 12.0);
        if (policy.taxVarianceExact && invLine.gstRate !== poGst) {
          lineMatchStatus = 'TAX_VARIANCE';
          lineVarianceNotes.push(`GST Rate variance: Invoiced ${invLine.gstRate}% vs PO ${poGst}%`);
        }
      }

      // 6. Free quantity & Scheme variance check
      if (poItem) {
        const expectedFree = Number(poItem.free_quantity_expected || 0);
        const actualFree = Number(invLine.freeQuantity || (grnItem ? grnItem.free_quantity : 0));
        if (expectedFree > 0 && actualFree < expectedFree) {
          lineMatchStatus = 'SCHEME_VARIANCE';
          schemeVarianceSummary = `Expected ${expectedFree} free units, received ${actualFree} free units`;
          lineVarianceNotes.push(schemeVarianceSummary);
        }
      }

      if (lineMatchStatus !== 'MATCHED') {
        overallStatus = lineMatchStatus;
        isException = true;
      }

      lineDetails.push({
        medicineId: invLine.medicineId,
        matchStatus: lineMatchStatus,
        notes: lineVarianceNotes.join('; '),
        invoiceQty: invLine.quantity,
        grnAcceptedQty: grnItem ? Number(grnItem.accepted_quantity || 0) : null,
        invoiceRatePaise: invLine.purchaseRatePaise,
        poRatePaise: poItem ? Number(poItem.purchase_rate_paise || 0) : null,
      });
    }

    const matchResultId = uuidv4();
    const matchRecord = localMutate({
      table: 'purchase_match_results',
      operation: 'INSERT',
      data: {
        id: matchResultId,
        _local_id: matchResultId,
        invoice_id: invoiceId,
        po_id: poId || null,
        grn_id: grnId || null,
        match_status: overallStatus,
        price_variance_paise: totalPriceVariancePaise,
        price_variance_pct: maxPriceVariancePct,
        quantity_variance: totalQuantityVariance,
        tax_variance_paise: totalTaxVariancePaise,
        scheme_variance_summary: schemeVarianceSummary,
        tolerance_applied: toleranceApplied ? 1 : 0,
        is_exception: isException ? 1 : 0,
        match_details_json: JSON.stringify(lineDetails),
      },
    });

    return matchRecord as any;
  }

  /**
   * Approve a match variance exception with supervisor authorization
   */
  static approveMatchException(params: {
    matchResultId: string;
    organizationId: string;
    approvedBy: string;
    userRole: string;
    reason: string;
  }): PurchaseMatchResult {
    const { matchResultId, organizationId, approvedBy, userRole, reason } = params;
    const matchRow: any = localDb.prepare('SELECT * FROM purchase_match_results WHERE id = ? OR _local_id = ?').get(matchResultId, matchResultId);
    if (!matchRow) throw new Error('Match result not found');

    if (!reason || !reason.trim()) {
      throw new Error('Approval reason is required for match variance exception');
    }

    const roleWeight: Record<string, number> = {
      CASHIER: 1,
      PHARMACIST: 2,
      STORE_MANAGER: 3,
      REGIONAL_MANAGER: 4,
      HQ_PROCUREMENT: 5,
      ADMIN: 10,
      OWNER: 10,
    };
    if ((roleWeight[userRole.toUpperCase()] || 1) < 3) {
      throw new Error('Unauthorized: Variance approval requires Store Manager or above');
    }

    const nowIso = new Date().toISOString();
    const updated = localMutate({
      table: 'purchase_match_results',
      operation: 'UPDATE',
      data: {
        _local_id: matchRow._local_id || matchRow.id,
        is_exception: 0,
        match_status: 'MATCHED',
        exception_approved_by: approvedBy,
        exception_approved_at: nowIso,
        exception_reason: reason,
      },
    });

    // Also update invoice match status
    localMutate({
      table: 'purchase_invoices',
      operation: 'UPDATE',
      data: {
        _local_id: matchRow.invoice_id,
        match_status: 'MATCHED',
      },
    });

    return updated as any;
  }
}
