import { localDb } from '../local-db';
import { Money } from '../lib/money';
import { FEFOEngine, BatchAllocation } from './fefoEngine';
import { ResolvedPriceSnapshot } from './pricingService';
import { CommercialEngine } from './commercial/commercialEngine';
import { CommercialQuoteResult, CouponValidationResult, CustomerMembership } from '../domain/commercialTypes';
import { AppError } from '../lib/appError';

export interface CartInputItem {
  medicine_id: string;
  batch_id?: string | null;
  quantity: number;
  unit_type?: string;
  conversion_factor?: number;
  discount_pct?: number;
  manual_unit_price?: number;
  notes?: string;
}

export interface CartQuoteLine {
  medicineId: string;
  medicineName: string;
  genericName: string | null;
  brandName: string | null;
  composition: string | null;
  dosageForm: string | null;
  scheduleClassification: string;
  prescriptionRequired: boolean;
  coldChainRequired: boolean;
  unitType: string;
  conversionFactor: number;
  requestedQuantity: number;
  baseQuantity: number;
  pricing: ResolvedPriceSnapshot;
  batchAllocations: BatchAllocation[];
  warnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }>;
  requiresApproval: boolean;
  freeQuantity?: number;
  rewardMedicineId?: string;
  appliedPromotionId?: string;
  appliedPromotionCode?: string;
  appliedPromotionName?: string;
  promotionDiscountPaise?: number;
  membershipDiscountPaise?: number;
  manualDiscountPaise?: number;
  savingsPaise?: number;
}

export interface CartQuoteResult {
  lines: CartQuoteLine[];
  subtotal: number;
  subtotalPaise: number;
  totalDiscount: number;
  totalDiscountPaise: number;
  taxableAmount: number;
  taxableAmountPaise: number;
  totalGst: number;
  totalGstPaise: number;
  cgst: number;
  cgstPaise: number;
  sgst: number;
  sgstPaise: number;
  igst: number;
  igstPaise: number;
  roundOff: number;
  roundOffPaise: number;
  grandTotal: number;
  grandTotalPaise: number;
  hasPrescriptionMedication: boolean;
  hasNearExpiryMedication: boolean;
  requiresSupervisorApproval: boolean;
  approvalReasons: string[];
}

export interface CartQuoteResultExtended extends CartQuoteResult {
  mrpTotal: number;
  mrpTotalPaise: number;
  basePriceTotal: number;
  basePriceTotalPaise: number;
  promotionDiscount: number;
  promotionDiscountPaise: number;
  membershipDiscount: number;
  membershipDiscountPaise: number;
  couponDiscount: number;
  couponDiscountPaise: number;
  manualDiscount: number;
  manualDiscountPaise: number;
  loyaltyRedeemed: number;
  loyaltyRedeemedPaise: number;
  loyaltyCreditsRedeemed: number;
  loyaltyCreditsEarnable: number;
  availableLoyaltyCredits: number;
  availableLoyaltyValuePaise: number;
  totalSavings: number;
  totalSavingsPaise: number;
  overallGrossMarginPaise: number;
  overallGrossMarginPct: number;
  appliedPromotions: Array<{ id: string; code: string; name: string; discountPaise: number; freeQty: number }>;
  rejectedPromotions: Array<{ id: string; code: string; name: string; reason: string }>;
  couponValidation?: CouponValidationResult | null;
  customerMembership?: CustomerMembership | null;
  customerGroupName?: string | null;
}

export class POSCartService {
  /**
   * Generates a fully validated server-side quote for a POS cart powered by the CommercialEngine.
   */
  static generateQuote(params: {
    items: CartInputItem[];
    organizationId: string;
    storeId: string;
    counterId?: string | null;
    terminalId?: string | null;
    customerId?: string | null;
    couponCode?: string | null;
    redeemLoyaltyCredits?: number;
    billDiscount?: number;
    paidAmount?: number;
    isInterstate?: boolean;
    isOffline?: boolean;
  }): CartQuoteResultExtended {
    const {
      items,
      organizationId,
      storeId,
      counterId = null,
      terminalId = null,
      customerId = null,
      couponCode = null,
      redeemLoyaltyCredits = 0,
      billDiscount = 0,
      paidAmount = 0,
      isInterstate = false,
      isOffline = false,
    } = params;

    if (!items || items.length === 0) {
      return {
        lines: [],
        subtotal: 0,
        subtotalPaise: 0,
        mrpTotal: 0,
        mrpTotalPaise: 0,
        basePriceTotal: 0,
        basePriceTotalPaise: 0,
        promotionDiscount: 0,
        promotionDiscountPaise: 0,
        membershipDiscount: 0,
        membershipDiscountPaise: 0,
        couponDiscount: 0,
        couponDiscountPaise: 0,
        manualDiscount: 0,
        manualDiscountPaise: 0,
        totalDiscount: 0,
        totalDiscountPaise: 0,
        loyaltyRedeemed: 0,
        loyaltyRedeemedPaise: 0,
        loyaltyCreditsRedeemed: 0,
        loyaltyCreditsEarnable: 0,
        availableLoyaltyCredits: 0,
        availableLoyaltyValuePaise: 0,
        taxableAmount: 0,
        taxableAmountPaise: 0,
        totalGst: 0,
        totalGstPaise: 0,
        cgst: 0,
        cgstPaise: 0,
        sgst: 0,
        sgstPaise: 0,
        igst: 0,
        igstPaise: 0,
        roundOff: 0,
        roundOffPaise: 0,
        grandTotal: 0,
        grandTotalPaise: 0,
        totalSavings: 0,
        totalSavingsPaise: 0,
        overallGrossMarginPaise: 0,
        overallGrossMarginPct: 0,
        hasPrescriptionMedication: false,
        hasNearExpiryMedication: false,
        requiresSupervisorApproval: false,
        approvalReasons: [],
        appliedPromotions: [],
        rejectedPromotions: [],
        couponValidation: null,
      };
    }

    // 1. Invoke CommercialEngine for Authoritative Commercial Breakdown
    const commercialQuote = CommercialEngine.quoteCommercialCart({
      organizationId,
      storeId,
      counterId,
      terminalId,
      customerId,
      items: items.map(it => ({
        medicine_id: it.medicine_id,
        batch_id: it.batch_id || null,
        quantity: it.quantity,
        unit_type: it.unit_type,
        conversion_factor: it.conversion_factor,
        requested_discount_pct: it.discount_pct || 0,
        manual_unit_price: it.manual_unit_price,
      })),
      couponCode,
      redeemLoyaltyCredits,
      billDiscountPaise: Money.toPaise(billDiscount),
      paidAmount,
      isInterstate,
      isOffline,
    });

    const quoteLines: CartQuoteLine[] = [];
    let hasPrescription = false;
    let hasNearExpiry = false;
    let requiresApproval = commercialQuote.requiresSupervisorApproval;
    const approvalReasons: string[] = [...commercialQuote.approvalReasons];

    // 2. Plan FEFO allocations and construct line views
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const commLine = commercialQuote.lines[i];

      const medRow: any = localDb
        .prepare('SELECT * FROM medicines WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
        .get(item.medicine_id, item.medicine_id);

      if (!medRow) {
        throw new AppError(404, `Medicine not found or inactive: ${item.medicine_id}`, 'MEDICINE_NOT_FOUND');
      }

      // Total quantity needed including free promotional items
      const totalUnitsToAllocate = commLine.baseQuantity + (commLine.freeQuantity * commLine.conversionFactor);

      // Plan FEFO Multi-Batch Allocations
      const fefo = FEFOEngine.planAllocations({
        medicineId: medRow.id || medRow._local_id,
        storeId,
        organizationId,
        requestedQuantity: totalUnitsToAllocate,
        manualBatchId: item.batch_id || null,
      });

      const lineWarnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }> = [
        ...commLine.warnings,
      ];

      const isPrescription = Boolean(medRow.prescription_required || medRow.is_schedule_h1);
      if (isPrescription) {
        hasPrescription = true;
        lineWarnings.push({
          code: 'PRESCRIPTION_REQUIRED',
          message: `Prescription required for ${medRow.name} (${medRow.schedule_classification || 'SCHEDULE_H'})`,
          severity: 'INFO',
        });
      }

      if (fefo.hasNearExpiryWarning) {
        hasNearExpiry = true;
        lineWarnings.push({
          code: 'NEAR_EXPIRY_ALLOCATION',
          message: 'Allocated batch is near expiry date.',
          severity: 'WARNING',
        });
      }

      const legacyPricingSnapshot: ResolvedPriceSnapshot = {
        mrp: commLine.mrp,
        mrpPaise: commLine.mrpPaise,
        unitSellingPrice: commLine.basePrice,
        unitSellingPricePaise: commLine.basePricePaise,
        minAllowedPrice: Money.toRupees(commLine.margin.costPaise),
        minAllowedPricePaise: commLine.margin.costPaise,
        discountPct: commLine.requestedQuantity > 0 ? Money.round2((commLine.totalDiscountPaise / (commLine.basePricePaise * commLine.requestedQuantity)) * 100) : 0,
        discountAmountPaise: commLine.totalDiscountPaise,
        effectiveUnitPrice: commLine.effectiveUnitPrice,
        effectiveUnitPricePaise: commLine.effectiveUnitPricePaise,
        taxableAmountPaise: commLine.taxableAmountPaise,
        gstRate: commLine.gstRate,
        taxAmountPaise: commLine.taxAmountPaise,
        cgstPaise: commLine.cgstPaise,
        sgstPaise: commLine.sgstPaise,
        igstPaise: commLine.igstPaise,
        lineTotalPaise: commLine.lineTotalPaise,
        lineTotal: commLine.lineTotal,
        priceSource: commLine.priceSource,
        priceSourceName: commLine.priceSourceName,
        requiresSupervisorApproval: commLine.requiresSupervisorApproval,
        approvalReason: commLine.approvalReasons[0],
      };

      quoteLines.push({
        medicineId: medRow.id || medRow._local_id,
        medicineName: medRow.name,
        genericName: medRow.generic_name || null,
        brandName: medRow.brand_name || null,
        composition: medRow.composition || null,
        dosageForm: medRow.dosage_form || null,
        scheduleClassification: medRow.schedule_classification || (medRow.is_schedule_h1 ? 'SCHEDULE_H1' : 'NONE'),
        prescriptionRequired: isPrescription,
        coldChainRequired: Boolean(medRow.cold_chain_required),
        unitType: commLine.unitType,
        conversionFactor: commLine.conversionFactor,
        requestedQuantity: commLine.requestedQuantity,
        baseQuantity: commLine.baseQuantity,
        pricing: legacyPricingSnapshot,
        batchAllocations: fefo.allocations,
        warnings: lineWarnings,
        requiresApproval: commLine.requiresSupervisorApproval,
        freeQuantity: commLine.freeQuantity,
        rewardMedicineId: commLine.rewardMedicineId,
        appliedPromotionId: commLine.appliedPromotionId,
        appliedPromotionCode: commLine.appliedPromotionCode,
        appliedPromotionName: commLine.appliedPromotionName,
        promotionDiscountPaise: commLine.promotionDiscountPaise,
        membershipDiscountPaise: commLine.membershipDiscountPaise,
        manualDiscountPaise: commLine.manualDiscountPaise,
        savingsPaise: commLine.savingsPaise,
      });
    }

    return {
      lines: quoteLines,
      subtotal: commercialQuote.subtotal,
      subtotalPaise: commercialQuote.subtotalPaise,
      mrpTotal: commercialQuote.mrpTotal,
      mrpTotalPaise: commercialQuote.mrpTotalPaise,
      basePriceTotal: commercialQuote.basePriceTotal,
      basePriceTotalPaise: commercialQuote.basePriceTotalPaise,
      promotionDiscount: commercialQuote.promotionDiscount,
      promotionDiscountPaise: commercialQuote.promotionDiscountPaise,
      membershipDiscount: commercialQuote.membershipDiscount,
      membershipDiscountPaise: commercialQuote.membershipDiscountPaise,
      couponDiscount: commercialQuote.couponDiscount,
      couponDiscountPaise: commercialQuote.couponDiscountPaise,
      manualDiscount: commercialQuote.manualDiscount,
      manualDiscountPaise: commercialQuote.manualDiscountPaise,
      totalDiscount: commercialQuote.totalDiscount,
      totalDiscountPaise: commercialQuote.totalDiscountPaise,
      loyaltyRedeemed: commercialQuote.loyaltyRedeemed,
      loyaltyRedeemedPaise: commercialQuote.loyaltyRedeemedPaise,
      loyaltyCreditsRedeemed: commercialQuote.loyaltyCreditsRedeemed,
      loyaltyCreditsEarnable: commercialQuote.loyaltyCreditsEarnable,
      availableLoyaltyCredits: commercialQuote.availableLoyaltyCredits,
      availableLoyaltyValuePaise: commercialQuote.availableLoyaltyValuePaise,
      taxableAmount: commercialQuote.taxableAmount,
      taxableAmountPaise: commercialQuote.taxableAmountPaise,
      totalGst: commercialQuote.totalGst,
      totalGstPaise: commercialQuote.totalGstPaise,
      cgst: commercialQuote.cgst,
      cgstPaise: commercialQuote.cgstPaise,
      sgst: commercialQuote.sgst,
      sgstPaise: commercialQuote.sgstPaise,
      igst: commercialQuote.igst,
      igstPaise: commercialQuote.igstPaise,
      roundOff: commercialQuote.roundOff,
      roundOffPaise: commercialQuote.roundOffPaise,
      grandTotal: commercialQuote.grandTotal,
      grandTotalPaise: commercialQuote.grandTotalPaise,
      totalSavings: commercialQuote.totalSavings,
      totalSavingsPaise: commercialQuote.totalSavingsPaise,
      overallGrossMarginPaise: commercialQuote.overallGrossMarginPaise,
      overallGrossMarginPct: commercialQuote.overallGrossMarginPct,
      hasPrescriptionMedication: hasPrescription,
      hasNearExpiryMedication: hasNearExpiry,
      requiresSupervisorApproval: requiresApproval,
      approvalReasons: Array.from(new Set(approvalReasons)),
      appliedPromotions: commercialQuote.appliedPromotions,
      rejectedPromotions: commercialQuote.rejectedPromotions,
      couponValidation: commercialQuote.couponValidation,
      customerMembership: commercialQuote.customerMembership,
      customerGroupName: commercialQuote.customerGroupName,
    };
  }
}
