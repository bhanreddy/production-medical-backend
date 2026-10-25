/**
 * Enterprise Pharmacy POS — Canonical Money & GST Precision Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Financial calculations must NEVER rely on unsafe IEEE-754 floating point arithmetic.
 * All monetary values are handled either in integer minor units (paise: 1 INR = 100 paise)
 * or rounded half-up to exact 2-decimal places (Rupees) / 4-decimal places (unit rates).
 */

export interface GstSplit {
  /** Taxable value before tax in Rupees (2 decimals) */
  taxableAmount: number;
  /** GST rate percentage (e.g. 0, 5, 12, 18, 28) */
  gstRate: number;
  /** Total GST tax amount in Rupees (2 decimals) */
  gstAmount: number;
  /** Central GST (50% of total GST for intra-state) */
  cgst: number;
  /** State GST (50% of total GST for intra-state) */
  sgst: number;
  /** Integrated GST (100% of GST for inter-state) */
  igst: number;
  /** Total gross amount (taxableAmount + gstAmount) */
  grossAmount: number;
}

export interface CalculatedLineItem {
  quantity: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  taxableAmount: number;
  gstRate: number;
  gstAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface GrandTotalSummary {
  subtotal: number;
  lineDiscountTotal: number;
  billDiscountAmount: number;
  totalDiscount: number;
  taxableSubtotal: number;
  totalGst: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  grandTotal: number;
  paidAmount: number;
  balanceDue: number;
  roundedGrandTotal: number;
  roundOffAmount: number;
}

export const Money = {
  /**
   * Convert Rupees (e.g. 149.50) to exact integer Paise (14950).
   */
  toPaise(rupees: number | string): number {
    const n = typeof rupees === "string" ? parseFloat(rupees) : rupees;
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  },

  /**
   * Convert integer Paise (e.g. 14950) to Rupees float (149.50).
   */
  fromPaise(paise: number | string): number {
    const n = typeof paise === "string" ? parseInt(paise, 10) : paise;
    if (!Number.isFinite(n)) return 0;
    return Math.round(n) / 100;
  },

  /**
   * Convert integer Paise to Rupees float (alias for fromPaise).
   */
  toRupees(paise: number | string): number {
    return Money.fromPaise(paise);
  },

  /**
   * Round a number to exact 2 decimal places using standard commercial half-up rounding.
   * Eliminates 0.1 + 0.2 = 0.30000000000000004 drift.
   */
  round2(value: number | string): number {
    const n = typeof value === "string" ? parseFloat(value) : value;
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  },

  /**
   * Alias for round2.
   */
  round(value: number | string): number {
    return Money.round2(value);
  },

  /**
   * Round to 4 decimal places for intermediate unit purchase/cost rates.
   */
  round4(value: number | string): number {
    const n = typeof value === "string" ? parseFloat(value) : value;
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 10000) / 10000;
  },

  /**
   * Safe commercial addition with 2-decimal rounding.
   */
  add(...values: (number | string)[]): number {
    const sum = values.reduce<number>((acc, v) => {
      const n = typeof v === "string" ? parseFloat(v) : v;
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
    return Money.round2(sum);
  },

  /**
   * Safe commercial subtraction with 2-decimal rounding.
   */
  subtract(a: number | string, b: number | string): number {
    const na = typeof a === "string" ? parseFloat(a) : a;
    const nb = typeof b === "string" ? parseFloat(b) : b;
    return Money.round2(
      (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0),
    );
  },

  /**
   * Safe commercial multiplication with 2-decimal rounding.
   */
  multiply(a: number | string, b: number | string): number {
    const na = typeof a === "string" ? parseFloat(a) : a;
    const nb = typeof b === "string" ? parseFloat(b) : b;
    return Money.round2(
      (Number.isFinite(na) ? na : 0) * (Number.isFinite(nb) ? nb : 0),
    );
  },

  /**
   * Calculate percentage amount e.g. 10% of 250 = 25.00.
   */
  percentage(amount: number | string, pct: number | string): number {
    const a = typeof amount === "string" ? parseFloat(amount) : amount;
    const p = typeof pct === "string" ? parseFloat(pct) : pct;
    if (!Number.isFinite(a) || !Number.isFinite(p) || p <= 0) return 0;
    return Money.round2((a * p) / 100);
  },

  /**
   * Calculate GST Split (Intra-state: CGST + SGST; Inter-state: IGST).
   */
  calculateGstSplit(
    taxableAmount: number,
    gstRate: number,
    isInterstate = false,
  ): GstSplit {
    const taxable = Money.round2(taxableAmount);
    const rate = Math.max(0, Number(gstRate) || 0);

    if (rate === 0 || taxable <= 0) {
      return {
        taxableAmount: taxable,
        gstRate: 0,
        gstAmount: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        grossAmount: taxable,
      };
    }

    const totalGst = Money.round2((taxable * rate) / 100);

    if (isInterstate) {
      return {
        taxableAmount: taxable,
        gstRate: rate,
        gstAmount: totalGst,
        cgst: 0,
        sgst: 0,
        igst: totalGst,
        grossAmount: Money.round2(taxable + totalGst),
      };
    }

    // Intra-state split: 50% CGST + 50% SGST
    // Handle odd-paise split deterministically: CGST gets half, SGST gets balance
    const halfGst = Money.round2(totalGst / 2);
    const otherHalf = Money.round2(totalGst - halfGst);

    return {
      taxableAmount: taxable,
      gstRate: rate,
      gstAmount: totalGst,
      cgst: halfGst,
      sgst: otherHalf,
      igst: 0,
      grossAmount: Money.round2(taxable + totalGst),
    };
  },

  /**
   * Calculate a single line item with quantity, unit price (MRP or purchase rate), discount, and GST.
   */
  calculateLineItem(params: {
    quantity: number;
    unitPrice: number;
    discountPct?: number;
    gstRate?: number;
    isInterstate?: boolean;
    priceIncludesTax?: boolean;
  }): CalculatedLineItem {
    const qty = Math.max(0, Number(params.quantity) || 0);
    const price = Math.max(0, Number(params.unitPrice) || 0);
    const discPct = Math.min(100, Math.max(0, Number(params.discountPct) || 0));
    const gstRate = Math.max(0, Number(params.gstRate) || 0);
    const isInterstate = Boolean(params.isInterstate);

    const grossLine = Money.round2(qty * price);
    const discountAmount =
      discPct > 0 ? Money.round2((grossLine * discPct) / 100) : 0;
    const discountedPrice = Money.round2(grossLine - discountAmount);
    const taxableAmount = params.priceIncludesTax
      ? Money.round2(discountedPrice / (1 + gstRate / 100))
      : discountedPrice;
    const gst = Money.calculateGstSplit(taxableAmount, gstRate, isInterstate);
    if (params.priceIncludesTax) {
      gst.gstAmount = Money.round2(discountedPrice - taxableAmount);
      gst.cgst = isInterstate ? 0 : Money.round2(gst.gstAmount / 2);
      gst.sgst = isInterstate ? 0 : Money.round2(gst.gstAmount - gst.cgst);
      gst.igst = isInterstate ? gst.gstAmount : 0;
      gst.grossAmount = discountedPrice;
    }

    return {
      quantity: qty,
      unitPrice: price,
      discountPct: discPct,
      discountAmount,
      taxableAmount,
      gstRate,
      gstAmount: gst.gstAmount,
      cgst: gst.cgst,
      sgst: gst.sgst,
      igst: gst.igst,
      total: gst.grossAmount,
    };
  },

  /**
   * Calculate comprehensive grand total across multiple line items.
   */
  calculateGrandTotal(params: {
    items: {
      quantity: number;
      unitPrice: number;
      discountPct?: number;
      gstRate?: number;
    }[];
    billDiscount?: number;
    isBillDiscountPercentage?: boolean;
    paidAmount?: number;
    isInterstate?: boolean;
    priceIncludesTax?: boolean;
  }): GrandTotalSummary {
    const isInterstate = Boolean(params.isInterstate);
    let subtotal = 0;
    let lineDiscountTotal = 0;
    let taxableSubtotal = 0;
    let totalGst = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;

    for (const item of params.items) {
      const calc = Money.calculateLineItem({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPct: item.discountPct,
        gstRate: item.gstRate,
        isInterstate,
        priceIncludesTax: params.priceIncludesTax,
      });

      subtotal = Money.add(
        subtotal,
        Money.multiply(calc.quantity, calc.unitPrice),
      );
      lineDiscountTotal = Money.add(lineDiscountTotal, calc.discountAmount);
      taxableSubtotal = Money.add(taxableSubtotal, calc.taxableAmount);
      totalGst = Money.add(totalGst, calc.gstAmount);
      totalCgst = Money.add(totalCgst, calc.cgst);
      totalSgst = Money.add(totalSgst, calc.sgst);
      totalIgst = Money.add(totalIgst, calc.igst);
    }

    // Bill-level discount calculation
    let billDiscountAmount = 0;
    if (params.billDiscount && params.billDiscount > 0) {
      if (params.isBillDiscountPercentage) {
        billDiscountAmount = Money.percentage(
          params.priceIncludesTax
            ? Money.subtract(subtotal, lineDiscountTotal)
            : taxableSubtotal,
          params.billDiscount,
        );
      } else {
        billDiscountAmount = Money.round2(params.billDiscount);
      }
    }
    billDiscountAmount = Math.min(
      billDiscountAmount,
      params.priceIncludesTax
        ? Money.subtract(subtotal, lineDiscountTotal)
        : taxableSubtotal,
    );
    if (params.priceIncludesTax && billDiscountAmount > 0) {
      const discountedGross = Money.subtract(subtotal, lineDiscountTotal);
      const ratio =
        discountedGross > 0
          ? (discountedGross - billDiscountAmount) / discountedGross
          : 0;
      totalGst = Money.round2(totalGst * ratio);
      totalCgst = isInterstate ? 0 : Money.round2(totalGst / 2);
      totalSgst = isInterstate ? 0 : Money.subtract(totalGst, totalCgst);
      totalIgst = isInterstate ? totalGst : 0;
      taxableSubtotal = Money.subtract(
        Money.subtract(discountedGross, billDiscountAmount),
        totalGst,
      );
    }

    const totalDiscount = Money.add(lineDiscountTotal, billDiscountAmount);
    const grandTotal = Money.round2(
      Math.max(
        0,
        subtotal - totalDiscount + (params.priceIncludesTax ? 0 : totalGst),
      ),
    );
    const roundedGrandTotal = Math.round(grandTotal);
    const roundOffAmount = Money.round2(roundedGrandTotal - grandTotal);

    const paid =
      params.paidAmount !== undefined
        ? Money.round2(params.paidAmount)
        : grandTotal;
    const balanceDue = Money.round2(Math.max(0, grandTotal - paid));

    return {
      subtotal,
      lineDiscountTotal,
      billDiscountAmount,
      totalDiscount,
      taxableSubtotal,
      totalGst,
      totalCgst,
      totalSgst,
      totalIgst,
      grandTotal,
      paidAmount: paid,
      balanceDue,
      roundedGrandTotal,
      roundOffAmount,
    };
  },

  /**
   * Calculate blended weighted average purchase cost when adding stock to an existing batch.
   */
  calculateBlendedPurchasePrice(params: {
    existingQuantity: number;
    existingPurchasePrice: number;
    newQuantity: number;
    newPurchasePrice: number;
  }): number {
    const oldQty = Math.max(0, Number(params.existingQuantity) || 0);
    const oldPrice = Math.max(0, Number(params.existingPurchasePrice) || 0);
    const newQty = Math.max(0, Number(params.newQuantity) || 0);
    const newPrice = Math.max(0, Number(params.newPurchasePrice) || 0);

    const totalQty = oldQty + newQty;
    if (totalQty === 0) return Money.round4(newPrice);
    if (oldQty === 0) return Money.round4(newPrice);

    const totalCost = oldQty * oldPrice + newQty * newPrice;
    return Money.round4(totalCost / totalQty);
  },

  /**
   * Format Indian Rupee currency with standard comma separators (e.g. ₹1,49,500.00).
   */
  formatInr(amount: number | string): string {
    const n = typeof amount === "string" ? parseFloat(amount) : amount;
    if (!Number.isFinite(n)) return "₹0.00";
    return n.toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },
};
