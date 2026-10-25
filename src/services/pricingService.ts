import { localDb } from '../local-db';
import { Money } from '../lib/money';
import { PriceBookService } from './commercial/priceBookService';
import { MarginGuard } from './commercial/marginGuard';

export interface PriceResolveContext {
  organizationId: string;
  storeId?: string | null;
  regionId?: string | null;
  medicineId: string;
  batchId?: string | null;
  customerId?: string | null;
  quantity: number;
  unitType?: string;
  conversionFactor?: number;
  requestedDiscountPct?: number;
  isInterstate?: boolean;
  manualUnitPrice?: number;
}

export interface ResolvedPriceSnapshot {
  mrp: number;
  mrpPaise: number;
  unitSellingPrice: number;
  unitSellingPricePaise: number;
  minAllowedPrice: number;
  minAllowedPricePaise: number;
  discountPct: number;
  discountAmountPaise: number;
  effectiveUnitPrice: number;
  effectiveUnitPricePaise: number;
  taxableAmountPaise: number;
  gstRate: number;
  taxAmountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
  lineTotal: number;
  priceSource?: string;
  priceSourceName?: string;
  requiresSupervisorApproval: boolean;
  approvalReason?: string;
}

export class PricingService {
  /**
   * Maximum discount percentage allowed without supervisor override
   */
  private static readonly MAX_UNSUPERVISED_DISCOUNT_PCT = 15.0;

  /**
   * Resolves price snapshot for a given product and line quantity using the Commercial Engine hierarchy
   */
  static resolvePrice(context: PriceResolveContext): ResolvedPriceSnapshot {
    const {
      organizationId,
      storeId,
      regionId,
      medicineId,
      batchId,
      customerId,
      quantity,
      conversionFactor = 1.0,
      unitType = 'STRIP',
      requestedDiscountPct = 0,
      isInterstate = false,
      manualUnitPrice,
    } = context;

    // 1. Resolve Price Hierarchy (Store > Region > Org > Customer Group > Master)
    const hierarchy = PriceBookService.resolveHierarchy({
      organizationId,
      storeId,
      regionId,
      customerId,
      medicineId,
      batchId,
      unitType,
      conversionFactor,
    });

    // Fetch GST Rate
    const medRow: any = localDb
      .prepare('SELECT gst_rate FROM medicines WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
      .get(medicineId, medicineId);
    const gstRate = Number(medRow?.gst_rate ?? 12);

    const effectiveBasePricePaise = manualUnitPrice != null
      ? Money.toPaise(manualUnitPrice * conversionFactor)
      : hierarchy.basePricePaise;

    const mrpPaise = hierarchy.mrpPaise;
    const mrp = Money.toRupees(mrpPaise);
    const unitSellingPrice = Money.toRupees(effectiveBasePricePaise);
    const unitSellingPricePaise = effectiveBasePricePaise;

    const discountPct = Math.max(0, Math.min(100, requestedDiscountPct));
    const effectiveUnitPrice = Money.round2(unitSellingPrice * (1 - discountPct / 100));
    const effectiveUnitPricePaise = Money.toPaise(effectiveUnitPrice);

    // 2. Margin Guard and Approval Evaluation
    const marginEval = MarginGuard.evaluate({
      organizationId,
      storeId,
      medicineId,
      batchId,
      sellingPricePaise: effectiveUnitPricePaise,
      mrpPaise,
      discountPct,
      conversionFactor,
    });

    const requiresSupervisorApproval = marginEval.requiresSupervisorApproval || (discountPct > this.MAX_UNSUPERVISED_DISCOUNT_PCT);
    const approvalReason = marginEval.approvalReason || (discountPct > this.MAX_UNSUPERVISED_DISCOUNT_PCT
      ? `Discount of ${discountPct}% exceeds standard authorization threshold (${this.MAX_UNSUPERVISED_DISCOUNT_PCT}%)`
      : undefined);

    // 3. Exact Money GST Calculation
    const lineCalc = Money.calculateLineItem({
      quantity,
      unitPrice: unitSellingPrice,
      discountPct,
      gstRate,
      isInterstate,
    });

    return {
      mrp,
      mrpPaise,
      unitSellingPrice,
      unitSellingPricePaise,
      minAllowedPrice: Money.toRupees(hierarchy.minAllowedPricePaise),
      minAllowedPricePaise: hierarchy.minAllowedPricePaise,
      discountPct,
      discountAmountPaise: Money.toPaise(lineCalc.discountAmount),
      effectiveUnitPrice,
      effectiveUnitPricePaise,
      taxableAmountPaise: Money.toPaise(lineCalc.taxableAmount),
      gstRate,
      taxAmountPaise: Money.toPaise(lineCalc.gstAmount),
      cgstPaise: Money.toPaise(lineCalc.cgst),
      sgstPaise: Money.toPaise(lineCalc.sgst),
      igstPaise: Money.toPaise(lineCalc.igst),
      lineTotalPaise: Money.toPaise(lineCalc.total),
      lineTotal: lineCalc.total,
      priceSource: hierarchy.source,
      priceSourceName: hierarchy.sourceName,
      requiresSupervisorApproval,
      approvalReason,
    };
  }
}
