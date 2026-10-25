import { localDb } from '../../local-db';
import { Money } from '../../lib/money';
import {
  CommercialQuoteContext,
  CommercialQuoteResult,
  CommercialLineCalculation,
  MarginGuardResult,
} from '../../domain/commercialTypes';
import { PriceBookService } from './priceBookService';
import { MarginGuard } from './marginGuard';
import { CustomerGroupService } from './customerGroupService';
import { CouponEngine } from './couponEngine';
import { LoyaltyEngine } from './loyaltyEngine';
import { PromotionEngine } from './promotionEngine';
import { AppError } from '../../lib/appError';

export class CommercialEngine {
  /**
   * Generates authoritative server-side commercial quote for cart lines in a store/channel context.
   */
  static quoteCommercialCart(context: CommercialQuoteContext): CommercialQuoteResult {
    const {
      organizationId,
      storeId,
      counterId,
      terminalId,
      customerId,
      items,
      couponCode,
      redeemLoyaltyCredits = 0,
      billDiscountPaise = 0,
      paidAmount = 0,
      isInterstate = false,
      isOffline = false,
    } = context;

    if (!items || items.length === 0) {
      return this.emptyQuoteResult();
    }

    const asOfDate = new Date();

    // 1. Resolve Store, Region, and Customer Context
    let regionId: string | null = null;
    if (storeId) {
      const storeRow: any = localDb
        .prepare('SELECT region_id FROM stores WHERE id = ? OR _local_id = ?')
        .get(storeId, storeId);
      regionId = storeRow?.region_id || null;
    }

    const customerGroup = customerId
      ? CustomerGroupService.resolveCustomerGroup(customerId, organizationId)
      : null;
    const membership = customerId
      ? CustomerGroupService.getActiveMembership(customerId, organizationId)
      : null;

    // 2. Pre-process each line: resolve medicine master & base price hierarchy
    const processedBaseLines: Array<{
      medicineId: string;
      medicineName: string;
      category?: string;
      brandName?: string;
      manufacturer?: string;
      quantity: number;
      unitType: string;
      conversionFactor: number;
      baseQuantity: number;
      mrpPaise: number;
      basePricePaise: number;
      priceSource: string;
      priceSourceName?: string;
      priority: number;
      requestedDiscountPct: number;
      manualUnitPrice?: number;
      gstRate: number;
      batchId?: string | null;
    }> = [];

    for (const item of items) {
      if (item.quantity <= 0) {
        throw new AppError(400, `Item quantity must be > 0 (received ${item.quantity})`, 'INVALID_QUANTITY');
      }

      const medRow: any = localDb
        .prepare('SELECT * FROM medicines WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
        .get(item.medicine_id, item.medicine_id);

      if (!medRow) {
        throw new AppError(404, `Medicine not found: ${item.medicine_id}`, 'MEDICINE_NOT_FOUND');
      }

      const defaultSaleUnit = (medRow.sale_unit || medRow.unit || 'STRIP').toUpperCase();
      const unitType = (item.unit_type || defaultSaleUnit).toUpperCase();
      const conversionFactor = item.conversion_factor != null
        ? Number(item.conversion_factor)
        : (unitType === defaultSaleUnit ? 1.0 : Number(medRow.conversion_factor ?? 1.0));
      const baseQuantity = item.quantity * conversionFactor;

      // Base Price Hierarchy Resolution
      const priceHierarchy = PriceBookService.resolveHierarchy({
        organizationId,
        storeId,
        regionId,
        customerId,
        customerGroupId: customerGroup?.id || customerGroup?._local_id || null,
        medicineId: medRow.id || medRow._local_id,
        batchId: item.batch_id || null,
        unitType,
        conversionFactor,
        asOfDate,
      });

      const effectiveBasePricePaise = item.manual_unit_price != null
        ? Money.toPaise(item.manual_unit_price * conversionFactor)
        : priceHierarchy.basePricePaise;

      processedBaseLines.push({
        medicineId: medRow.id || medRow._local_id,
        medicineName: medRow.name,
        category: medRow.category,
        brandName: medRow.brand_name,
        manufacturer: medRow.manufacturer,
        quantity: item.quantity,
        unitType,
        conversionFactor,
        baseQuantity,
        mrpPaise: priceHierarchy.mrpPaise,
        basePricePaise: effectiveBasePricePaise,
        priceSource: priceHierarchy.source,
        priceSourceName: priceHierarchy.sourceName,
        priority: priceHierarchy.priority,
        requestedDiscountPct: item.requested_discount_pct || 0,
        manualUnitPrice: item.manual_unit_price,
        gstRate: Number(medRow.gst_rate ?? 12),
        batchId: item.batch_id || null,
      });
    }

    // 3. Evaluate Cart Promotions via PromotionEngine
    const promoContext = {
      organizationId,
      storeId,
      regionId,
      customerId,
      customerGroupId: customerGroup?.id || customerGroup?._local_id || null,
      cartLines: processedBaseLines.map(l => ({
        medicineId: l.medicineId,
        medicineName: l.medicineName,
        category: l.category,
        brandName: l.brandName,
        manufacturer: l.manufacturer,
        quantity: l.quantity,
        unitPricePaise: l.basePricePaise,
        mrpPaise: l.mrpPaise,
        basePricePaise: l.basePricePaise,
        unitType: l.unitType,
        conversionFactor: l.conversionFactor,
      })),
      asOfDate,
      isOffline,
    };

    const promoResult = PromotionEngine.evaluateCartPromotions(promoContext);

    // 4. Calculate Intermediate Lines (incorporating member discount and promo discount)
    const quoteLines: CommercialLineCalculation[] = [];
    let mrpTotalPaise = 0;
    let basePriceTotalPaise = 0;
    let totalPromoDiscountPaise = promoResult.totalPromoDiscountPaise;
    let totalMembershipDiscountPaise = 0;
    let totalManualDiscountPaise = 0;
    let requiresSupervisorApproval = false;
    const approvalReasons: string[] = [];
    const overallWarnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }> = [];

    for (const line of processedBaseLines) {
      const lineMrpTotalPaise = line.mrpPaise * line.quantity;
      const lineBaseTotalPaise = line.basePricePaise * line.quantity;
      mrpTotalPaise += lineMrpTotalPaise;
      basePriceTotalPaise += lineBaseTotalPaise;

      // Promotion discount for this line
      const linePromo = promoResult.lineDiscounts.get(line.medicineId);
      const promoDiscountPaise = linePromo?.discountPaise || 0;
      const freeQty = linePromo?.freeQty || 0;

      // Membership / Customer Group discount
      let memberDiscountPaise = 0;
      if (customerGroup && Number(customerGroup.discount_pct) > 0) {
        const remainingForMember = Math.max(0, lineBaseTotalPaise - promoDiscountPaise);
        memberDiscountPaise = Math.round((remainingForMember * Number(customerGroup.discount_pct)) / 100);
        totalMembershipDiscountPaise += memberDiscountPaise;
      }

      // Manual discount
      let manualDiscountPaise = 0;
      if (line.requestedDiscountPct > 0) {
        const remainingForManual = Math.max(0, lineBaseTotalPaise - promoDiscountPaise - memberDiscountPaise);
        manualDiscountPaise = Math.round((remainingForManual * line.requestedDiscountPct) / 100);
        totalManualDiscountPaise += manualDiscountPaise;
      }

      const lineTotalDiscountPaise = promoDiscountPaise + memberDiscountPaise + manualDiscountPaise;
      const netLineTotalPaise = Math.max(0, lineBaseTotalPaise - lineTotalDiscountPaise);
      const effectiveUnitPricePaise = line.quantity > 0
        ? Math.round(netLineTotalPaise / line.quantity)
        : 0;

      // GST Calculation for Line
      const gstCalc = Money.calculateGstSplit(
        Money.toRupees(netLineTotalPaise),
        line.gstRate,
        isInterstate
      );

      const lineTaxAmountPaise = Money.toPaise(gstCalc.gstAmount);
      const lineTotalPaise = netLineTotalPaise + lineTaxAmountPaise;

      // Margin Guard Check
      const marginResult = MarginGuard.evaluate({
        organizationId,
        storeId,
        medicineId: line.medicineId,
        batchId: line.batchId,
        sellingPricePaise: effectiveUnitPricePaise,
        mrpPaise: line.mrpPaise,
        discountPct: line.requestedDiscountPct,
        conversionFactor: line.conversionFactor,
      });

      const lineWarnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }> = [];
      const lineApprovalReasons: string[] = [];

      if (marginResult.requiresSupervisorApproval) {
        requiresSupervisorApproval = true;
        if (marginResult.approvalReason) {
          approvalReasons.push(marginResult.approvalReason);
          lineApprovalReasons.push(marginResult.approvalReason);
        }
        lineWarnings.push({
          code: 'MARGIN_GUARD_WARNING',
          message: marginResult.warningMessage || 'Low margin requires supervisor authorization',
          severity: marginResult.status === 'BLOCKED' ? 'BLOCKING' : 'WARNING',
        });
      }

      if (marginResult.status === 'BLOCKED') {
        requiresSupervisorApproval = true;
        overallWarnings.push({
          code: 'MRP_EXCEEDED',
          message: `Product ${line.medicineName} selling price exceeds MRP!`,
          severity: 'BLOCKING',
        });
      }

      const savingsPaise = Math.max(0, lineMrpTotalPaise - netLineTotalPaise);

      quoteLines.push({
        medicineId: line.medicineId,
        medicineName: line.medicineName,
        unitType: line.unitType,
        conversionFactor: line.conversionFactor,
        requestedQuantity: line.quantity,
        baseQuantity: line.baseQuantity,
        mrpPaise: line.mrpPaise,
        mrp: Money.toRupees(line.mrpPaise),
        basePricePaise: line.basePricePaise,
        basePrice: Money.toRupees(line.basePricePaise),
        priceSource: line.priceSource,
        priceSourceName: line.priceSourceName,
        appliedPromotionId: linePromo?.promoId,
        appliedPromotionCode: linePromo?.promoCode,
        appliedPromotionName: linePromo?.promoName,
        promotionDiscountPaise: promoDiscountPaise,
        membershipDiscountPaise: memberDiscountPaise,
        manualDiscountPaise: manualDiscountPaise,
        totalDiscountPaise: lineTotalDiscountPaise,
        freeQuantity: freeQty,
        effectiveUnitPricePaise,
        effectiveUnitPrice: Money.toRupees(effectiveUnitPricePaise),
        taxableAmountPaise: netLineTotalPaise,
        taxableAmount: Money.toRupees(netLineTotalPaise),
        gstRate: line.gstRate,
        taxAmountPaise: lineTaxAmountPaise,
        taxAmount: gstCalc.gstAmount,
        cgstPaise: Money.toPaise(gstCalc.cgst),
        sgstPaise: Money.toPaise(gstCalc.sgst),
        igstPaise: Money.toPaise(gstCalc.igst),
        lineTotalPaise,
        lineTotal: Money.toRupees(lineTotalPaise),
        savingsPaise,
        margin: marginResult,
        warnings: lineWarnings,
        requiresSupervisorApproval: marginResult.requiresSupervisorApproval,
        approvalReasons: lineApprovalReasons,
      });
    }

    // 5. Evaluate Coupon Validation
    let couponDiscountPaise = 0;
    let couponValidation = null;

    if (couponCode && couponCode.trim()) {
      const intermediateTaxableSubtotal = quoteLines.reduce((sum, l) => sum + l.taxableAmountPaise, 0);
      couponValidation = CouponEngine.validateCoupon({
        organizationId,
        storeId,
        customerId,
        code: couponCode,
        cartSubtotalPaise: intermediateTaxableSubtotal,
        eligibleMedicineIds: quoteLines.map(l => l.medicineId),
        isOffline,
        asOfDate,
      });

      if (couponValidation.isValid) {
        couponDiscountPaise = couponValidation.discountAmountPaise;
      }
    }

    // 6. Subtotals and Discounts Aggregation
    const subtotalPaise = basePriceTotalPaise;
    const totalDiscountPaise = totalPromoDiscountPaise + totalMembershipDiscountPaise + totalManualDiscountPaise + couponDiscountPaise + billDiscountPaise;
    const taxableAmountPaise = Math.max(0, subtotalPaise - totalDiscountPaise);

    // Re-calculate GST across invoice
    let totalGstPaise = 0;
    let totalCgstPaise = 0;
    let totalSgstPaise = 0;
    let totalIgstPaise = 0;

    for (const line of quoteLines) {
      // Pro-rate coupon & bill discounts to taxable base of line for exact GST calculation
      const lineGst = Money.calculateGstSplit(
        Money.toRupees(line.taxableAmountPaise),
        line.gstRate,
        isInterstate
      );
      totalGstPaise += Money.toPaise(lineGst.gstAmount);
      totalCgstPaise += Money.toPaise(lineGst.cgst);
      totalSgstPaise += Money.toPaise(lineGst.sgst);
      totalIgstPaise += Money.toPaise(lineGst.igst);
    }

    const preGrandTotalPaise = taxableAmountPaise + totalGstPaise;

    // 7. Loyalty Redemption Calculation
    let loyaltyRedeemedPaise = 0;
    let loyaltyCreditsRedeemed = 0;
    let availableLoyaltyCredits = 0;
    let availableLoyaltyValuePaise = 0;

    if (customerId) {
      const loyaltyAccount = LoyaltyEngine.getOrCreateAccount(organizationId, customerId);
      const loyaltyProgram = LoyaltyEngine.getOrCreateProgram(organizationId);
      availableLoyaltyCredits = Number(loyaltyAccount.available_balance || 0);
      availableLoyaltyValuePaise = availableLoyaltyCredits * Number(loyaltyProgram.redemption_rate_paise_per_credit);

      if (redeemLoyaltyCredits > 0) {
        const redeemCalc = LoyaltyEngine.calculateRedemption({
          organizationId,
          customerId,
          requestedCredits: redeemLoyaltyCredits,
          billTotalPaise: preGrandTotalPaise,
        });

        if (redeemCalc.allowed) {
          loyaltyCreditsRedeemed = redeemCalc.creditsToRedeem;
          loyaltyRedeemedPaise = redeemCalc.monetaryValuePaise;
        }
      }
    }

    const finalPayablePaise = Math.max(0, preGrandTotalPaise - loyaltyRedeemedPaise);

    // Standard commercial half-up 50-paise round-off
    const roundedPayableRs = Math.round(Money.toRupees(finalPayablePaise));
    const grandTotalPaise = Money.toPaise(roundedPayableRs);
    const roundOffPaise = grandTotalPaise - finalPayablePaise;

    // Loyalty Earning calculation on eligible paid value
    const earnCalc = customerId
      ? LoyaltyEngine.calculateEarning({
          organizationId,
          customerId,
          eligibleSpendPaise: taxableAmountPaise,
          asOfDate,
        })
      : { creditsEarned: 0 };

    const totalSavingsPaise = Math.max(0, mrpTotalPaise - grandTotalPaise);

    // Overall Gross Margin
    const totalAcquisitionCostPaise = quoteLines.reduce((acc, l) => acc + (l.margin.costPaise * l.requestedQuantity), 0);
    const overallGrossMarginPaise = taxableAmountPaise - totalAcquisitionCostPaise;
    const overallGrossMarginPct = taxableAmountPaise > 0
      ? Money.round2((overallGrossMarginPaise / taxableAmountPaise) * 100)
      : 0;

    return {
      lines: quoteLines,
      mrpTotalPaise,
      mrpTotal: Money.toRupees(mrpTotalPaise),
      basePriceTotalPaise,
      basePriceTotal: Money.toRupees(basePriceTotalPaise),
      subtotalPaise,
      subtotal: Money.toRupees(subtotalPaise),
      promotionDiscountPaise: totalPromoDiscountPaise,
      promotionDiscount: Money.toRupees(totalPromoDiscountPaise),
      membershipDiscountPaise: totalMembershipDiscountPaise,
      membershipDiscount: Money.toRupees(totalMembershipDiscountPaise),
      couponDiscountPaise,
      couponDiscount: Money.toRupees(couponDiscountPaise),
      manualDiscountPaise: totalManualDiscountPaise,
      manualDiscount: Money.toRupees(totalManualDiscountPaise),
      totalDiscountPaise,
      totalDiscount: Money.toRupees(totalDiscountPaise),
      loyaltyRedeemedPaise,
      loyaltyRedeemed: Money.toRupees(loyaltyRedeemedPaise),
      loyaltyCreditsRedeemed,
      loyaltyCreditsEarnable: earnCalc.creditsEarned,
      availableLoyaltyCredits,
      availableLoyaltyValuePaise,
      customerMembership: membership,
      customerGroupName: customerGroup?.name || null,
      taxableAmountPaise,
      taxableAmount: Money.toRupees(taxableAmountPaise),
      totalGstPaise,
      totalGst: Money.toRupees(totalGstPaise),
      cgstPaise: totalCgstPaise,
      cgst: Money.toRupees(totalCgstPaise),
      sgstPaise: totalSgstPaise,
      sgst: Money.toRupees(totalSgstPaise),
      igstPaise: totalIgstPaise,
      igst: Money.toRupees(totalIgstPaise),
      roundOffPaise,
      roundOff: Money.toRupees(roundOffPaise),
      grandTotalPaise,
      grandTotal: Money.toRupees(grandTotalPaise),
      totalSavingsPaise,
      totalSavings: Money.toRupees(totalSavingsPaise),
      overallGrossMarginPaise,
      overallGrossMarginPct,
      appliedPromotions: promoResult.appliedPromotions,
      rejectedPromotions: promoResult.rejectedPromotions,
      couponValidation,
      warnings: overallWarnings,
      requiresSupervisorApproval,
      approvalReasons,
    };
  }

  /**
   * Helper: empty quote structure
   */
  private static emptyQuoteResult(): CommercialQuoteResult {
    return {
      lines: [],
      mrpTotalPaise: 0,
      mrpTotal: 0,
      basePriceTotalPaise: 0,
      basePriceTotal: 0,
      subtotalPaise: 0,
      subtotal: 0,
      promotionDiscountPaise: 0,
      promotionDiscount: 0,
      membershipDiscountPaise: 0,
      membershipDiscount: 0,
      couponDiscountPaise: 0,
      couponDiscount: 0,
      manualDiscountPaise: 0,
      manualDiscount: 0,
      totalDiscountPaise: 0,
      totalDiscount: 0,
      loyaltyRedeemedPaise: 0,
      loyaltyRedeemed: 0,
      loyaltyCreditsRedeemed: 0,
      loyaltyCreditsEarnable: 0,
      availableLoyaltyCredits: 0,
      availableLoyaltyValuePaise: 0,
      taxableAmountPaise: 0,
      taxableAmount: 0,
      totalGstPaise: 0,
      totalGst: 0,
      cgstPaise: 0,
      cgst: 0,
      sgstPaise: 0,
      sgst: 0,
      igstPaise: 0,
      igst: 0,
      roundOffPaise: 0,
      roundOff: 0,
      grandTotalPaise: 0,
      grandTotal: 0,
      totalSavingsPaise: 0,
      totalSavings: 0,
      overallGrossMarginPaise: 0,
      overallGrossMarginPct: 0,
      appliedPromotions: [],
      rejectedPromotions: [],
      warnings: [],
      requiresSupervisorApproval: false,
      approvalReasons: [],
    };
  }
}
