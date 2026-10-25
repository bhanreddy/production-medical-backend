// supplierIntelligenceService.ts — Enterprise Supplier Performance Analytics, Transparent Scorecards & Procurement Dashboard
import { localDb } from '../../local-db';
import { businessDate } from '../../lib/businessDate';
import { AppError } from '../../lib/appError';
import { Money } from '../../lib/money';
import {
  SupplierScorecard,
  ProcurementDashboardSummary,
} from '../../domain/procurementTypes';

export class SupplierIntelligenceService {
  /**
   * Compute Transparent Component-Based Scorecard for a Supplier
   */
  static getSupplierScorecard(organizationId: string, supplierId: string): SupplierScorecard {
    const supplier: any = localDb
      .prepare(
        `SELECT * FROM suppliers
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) LIMIT 1`
      )
      .get(supplierId, supplierId, organizationId);

    if (!supplier) {
      throw new AppError(404, 'Supplier not found');
    }

    const configuredLeadTime = Number(supplier.lead_time_days || 2);

    // 1. Fetch all POs for supplier
    const poRows: any[] = localDb
      .prepare(
        `SELECT * FROM purchase_orders
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?) AND _deleted = 0`
      )
      .all(organizationId, supplierId, supplierId);

    const totalOrders = poRows.length;
    let totalPurchaseValuePaise = 0;
    for (const po of poRows) {
      totalPurchaseValuePaise += Number(po.total_paise || Money.toPaise(Number(po.grand_total || 0)));
    }

    // 2. Fetch all GRNs for supplier to calculate lead time, on-time delivery, fill rate, damages, schemes
    const grnRows: any[] = localDb
      .prepare(
        `SELECT grn.*, po.expected_delivery_date, po.order_date
         FROM goods_receipts grn
         LEFT JOIN purchase_orders po ON po.id = grn.po_id OR po._local_id = grn.po_id
         WHERE (grn.organization_id = ?)
           AND (grn.supplier_id = ? OR grn.supplier_id = ?) AND grn.status = 'POSTED' AND grn._deleted = 0`
      )
      .all(organizationId, supplierId, supplierId);

    let totalLeadTimeDaysSum = 0;
    let leadTimeObservations = 0;
    let onTimeDeliveries = 0;
    let totalDeliveries = grnRows.length;

    for (const grn of grnRows) {
      if (grn.order_date && grn.received_at) {
        const orderDt = new Date(grn.order_date);
        const recvDt = new Date(grn.received_at);
        const days = Math.max(0, Math.ceil((recvDt.getTime() - orderDt.getTime()) / (1000 * 60 * 60 * 24)));
        totalLeadTimeDaysSum += days;
        leadTimeObservations++;

        if (grn.expected_delivery_date) {
          const expDt = new Date(grn.expected_delivery_date);
          if (recvDt.getTime() <= expDt.getTime() + 1000 * 60 * 60 * 24) {
            onTimeDeliveries++;
          }
        } else {
          onTimeDeliveries++;
        }
      }
    }

    const observedAvgLeadTimeDays = leadTimeObservations > 0 ? Math.round((totalLeadTimeDaysSum / leadTimeObservations) * 10) / 10 : configuredLeadTime;
    const onTimeDeliveryRatePct = totalDeliveries > 0 ? Math.round((onTimeDeliveries / totalDeliveries) * 10000) / 100 : 100.0;

    // 3. Fetch GRN line items for fill rate, short, excess, damage, rejection
    const grnItemRows: any[] = localDb
      .prepare(
        `SELECT gri.*, poi.free_quantity_expected
         FROM goods_receipt_items gri
         JOIN goods_receipts grn ON grn.id = gri.grn_id OR grn._local_id = gri.grn_id
         LEFT JOIN purchase_order_items poi ON poi.id = gri.po_item_id OR poi._local_id = gri.po_item_id
         WHERE (gri.organization_id = ?)
           AND (grn.supplier_id = ? OR grn.supplier_id = ?) AND grn.status = 'POSTED' AND gri._deleted = 0`
      )
      .all(organizationId, supplierId, supplierId);

    let totalOrderedUnits = 0;
    let totalAcceptedUnits = 0;
    let totalRejectedUnits = 0;
    let totalDamagedUnits = 0;
    let totalShortUnits = 0;
    let totalExcessUnits = 0;
    let totalExpectedFreeUnits = 0;
    let totalActualFreeUnits = 0;

    for (const item of grnItemRows) {
      const ord = Number(item.ordered_quantity || 0);
      const acc = Number(item.accepted_quantity || 0);
      const rej = Number(item.rejected_quantity || 0);
      const dmg = Number(item.damaged_quantity || 0);
      const srt = Number(item.short_quantity || 0);
      const exc = Number(item.excess_quantity || 0);
      const expFree = Number(item.free_quantity_expected || 0);
      const actFree = Number(item.free_quantity || 0);

      totalOrderedUnits += ord;
      totalAcceptedUnits += acc;
      totalRejectedUnits += rej;
      totalDamagedUnits += dmg;
      totalShortUnits += srt;
      totalExcessUnits += exc;
      totalExpectedFreeUnits += expFree;
      totalActualFreeUnits += actFree;
    }

    const fillRatePct = totalOrderedUnits > 0 ? Math.min(100, Math.round((totalAcceptedUnits / totalOrderedUnits) * 10000) / 100) : 100.0;
    const shortDeliveryRatePct = totalOrderedUnits > 0 ? Math.round((totalShortUnits / totalOrderedUnits) * 10000) / 100 : 0.0;
    const excessDeliveryRatePct = totalOrderedUnits > 0 ? Math.round((totalExcessUnits / totalOrderedUnits) * 10000) / 100 : 0.0;
    const rejectionRatePct = (totalAcceptedUnits + totalRejectedUnits) > 0 ? Math.round((totalRejectedUnits / (totalAcceptedUnits + totalRejectedUnits)) * 10000) / 100 : 0.0;
    const damagedReceiptRatePct = totalAcceptedUnits > 0 ? Math.round((totalDamagedUnits / totalAcceptedUnits) * 10000) / 100 : 0.0;
    const schemeFulfilmentRatePct = totalExpectedFreeUnits > 0 ? Math.min(100, Math.round((totalActualFreeUnits / totalExpectedFreeUnits) * 10000) / 100) : 100.0;

    // 4. Fetch Purchase Returns
    const returnRows: any[] = localDb
      .prepare(
        `SELECT COUNT(*) as count FROM purchase_returns
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?) AND _deleted = 0`
      )
      .all(organizationId, supplierId, supplierId);
    const returnCount = Number(returnRows[0]?.count || 0);
    const purchaseReturnRatePct = totalDeliveries > 0 ? Math.round((returnCount / totalDeliveries) * 10000) / 100 : 0.0;

    // 5. Fetch Invoice Mismatches
    const invoiceRows: any[] = localDb
      .prepare(
        `SELECT match_status FROM purchase_invoices
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?) AND _deleted = 0`
      )
      .all(organizationId, supplierId, supplierId);

    const totalInvoices = invoiceRows.length;
    const mismatchInvoices = invoiceRows.filter(i => i.match_status !== 'MATCHED').length;
    const invoiceMismatchRatePct = totalInvoices > 0 ? Math.round((mismatchInvoices / totalInvoices) * 10000) / 100 : 0.0;

    // 6. Calculate Component-Based Transparent Score (0-100)
    // Price Score: 20 pts (max if price variance is zero)
    const priceScore = 20;
    // Lead Time Score: 20 pts (max if observed <= configured)
    const leadTimeScore = Math.max(0, Math.min(20, Math.round(20 - Math.max(0, observedAvgLeadTimeDays - configuredLeadTime) * 3)));
    // Fill Rate Score: 20 pts
    const fillRateScore = Math.max(0, Math.min(20, Math.round((fillRatePct / 100) * 20)));
    // Quality & Damage Score: 20 pts (penalized by damage & rejection rates)
    const qualityScore = Math.max(0, Math.min(20, Math.round(20 - (rejectionRatePct + damagedReceiptRatePct) * 2)));
    // Scheme Honouring Score: 10 pts
    const schemeScore = Math.max(0, Math.min(10, Math.round((schemeFulfilmentRatePct / 100) * 10)));
    // Invoice Accuracy Score: 10 pts
    const invoiceAccuracyScore = Math.max(0, Math.min(10, Math.round(10 - invoiceMismatchRatePct * 0.1)));

    const overallScore = Math.min(100, priceScore + leadTimeScore + fillRateScore + qualityScore + schemeScore + invoiceAccuracyScore);

    let ratingGrade: 'A+' | 'A' | 'B' | 'C' | 'D' = 'A';
    if (overallScore >= 95) ratingGrade = 'A+';
    else if (overallScore >= 85) ratingGrade = 'A';
    else if (overallScore >= 70) ratingGrade = 'B';
    else if (overallScore >= 55) ratingGrade = 'C';
    else ratingGrade = 'D';

    return {
      supplierId,
      supplierName: supplier.name,
      totalPurchaseValuePaise,
      totalOrders,
      configuredLeadTimeDays: configuredLeadTime,
      observedAvgLeadTimeDays,
      onTimeDeliveryRatePct,
      fillRatePct,
      shortDeliveryRatePct,
      excessDeliveryRatePct,
      rejectionRatePct,
      damagedReceiptRatePct,
      purchaseReturnRatePct,
      priceVariancePct: 0.0,
      schemeFulfilmentRatePct,
      invoiceMismatchRatePct,
      overallScore,
      ratingGrade,
      scoreBreakdown: {
        priceScore,
        leadTimeScore,
        fillRateScore,
        qualityScore,
        schemeScore,
        invoiceAccuracyScore,
      },
    };
  }

  /**
   * Get High-Level Procurement Command Center Dashboard Summary
   */
  static getDashboardSummary(organizationId: string, storeId?: string | null): ProcurementDashboardSummary {
    const orgCond = 'organization_id = ? AND _deleted = 0';
    const storeCond = storeId ? ' AND (store_id = ? OR store_id IS NULL)' : '';

    const scope = storeId ? [organizationId, storeId] : [organizationId];
    const openReqs: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_requisitions WHERE ${orgCond} ${storeCond} AND status IN ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL')`).get(...scope);
    const pendingAppr: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_requisitions WHERE ${orgCond} ${storeCond} AND status = 'PENDING_APPROVAL'`).get(...scope);

    const openPos: any = localDb.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(total_paise), 0) as val FROM purchase_orders WHERE ${orgCond} ${storeCond} AND status IN ('APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED')`).get(...scope);
    const partialPos: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_orders WHERE ${orgCond} ${storeCond} AND status = 'PARTIALLY_RECEIVED'`).get(...scope);

    const timezone = (localDb.prepare('SELECT timezone FROM organizations WHERE id = ? OR _local_id = ?').get(organizationId, organizationId) as { timezone?: string } | undefined)?.timezone;
    const todayStr = businessDate(new Date(), timezone || 'Asia/Kolkata');
    const expDeliveries: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_orders WHERE ${orgCond} ${storeCond} AND expected_delivery_date = ? AND status IN ('APPROVED', 'SENT', 'CONFIRMED')`).get(...scope, todayStr);

    const grnReview: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM goods_receipts WHERE ${orgCond} ${storeCond} AND status = 'REVIEW'`).get(...scope);
    const matchExceptions: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_invoices WHERE ${orgCond} ${storeCond} AND match_status != 'MATCHED' AND status != 'POSTED'`).get(...scope);

    const suppBalances: any = localDb.prepare(`SELECT COALESCE(SUM(outstanding_balance), 0) as total FROM suppliers WHERE ${orgCond}`).get(organizationId);
    const totalSupplierOutstandingPaise = Money.toPaise(Number(suppBalances?.total || 0));

    const overduePayables: any = localDb.prepare(`SELECT COALESCE(SUM(balance_due_paise), 0) as overdue FROM purchase_invoices WHERE ${orgCond} ${storeCond} AND due_date < ? AND payment_status != 'PAID' AND status = 'POSTED'`).get(...scope, todayStr);

    const returnsMonth: any = localDb.prepare(`SELECT COUNT(*) as cnt FROM purchase_returns WHERE ${orgCond} ${storeCond}`).get(...scope);

    // Scheme savings: calculated from free quantities on posted GRNs
    const grnOrgCond = 'grn.organization_id = ? AND grn._deleted = 0';
    const grnStoreCond = storeId ? ' AND (grn.store_id = ? OR grn.store_id IS NULL)' : '';
    const schemeSavingsRow: any = localDb
      .prepare(
        `SELECT COALESCE(SUM(gri.free_quantity * gri.purchase_rate_paise), 0) as savings
         FROM goods_receipt_items gri
         JOIN goods_receipts grn ON grn.id = gri.grn_id OR grn._local_id = gri.grn_id
         WHERE ${grnOrgCond} ${grnStoreCond} AND grn.status = 'POSTED'`
      )
      .get(...scope);

    return {
      openRequisitionsCount: Number(openReqs?.cnt || 0),
      pendingApprovalsCount: Number(pendingAppr?.cnt || 0),
      openPurchaseOrdersCount: Number(openPos?.cnt || 0),
      openPurchaseOrdersValuePaise: Number(openPos?.val || 0),
      expectedDeliveriesTodayCount: Number(expDeliveries?.cnt || 0),
      partiallyReceivedPosCount: Number(partialPos?.cnt || 0),
      grnsPendingReviewCount: Number(grnReview?.cnt || 0),
      invoiceMatchExceptionsCount: Number(matchExceptions?.cnt || 0),
      totalSupplierOutstandingPaise,
      overduePayablesPaise: Number(overduePayables?.overdue || 0),
      purchaseReturnsMonthCount: Number(returnsMonth?.cnt || 0),
      schemeSavingsMonthPaise: Number(schemeSavingsRow?.savings || 0),
    };
  }
}
