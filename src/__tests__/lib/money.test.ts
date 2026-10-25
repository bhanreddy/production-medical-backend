import { Money } from "../../lib/money";

describe("Money Precision & GST Engine", () => {
  describe("toPaise & fromPaise", () => {
    test("converts rupees to integer paise accurately", () => {
      expect(Money.toPaise(149.5)).toBe(14950);
      expect(Money.toPaise(0.99)).toBe(99);
      expect(Money.toPaise("250.75")).toBe(25075);
      expect(Money.toPaise(0)).toBe(0);
    });

    test("converts paise to rupees with exact 2 decimals", () => {
      expect(Money.fromPaise(14950)).toBe(149.5);
      expect(Money.fromPaise(99)).toBe(0.99);
      expect(Money.fromPaise("25075")).toBe(250.75);
      expect(Money.fromPaise(0)).toBe(0);
    });
  });

  describe("round2 & round4", () => {
    test("eliminates standard floating point precision drift", () => {
      const floatDrift = 0.1 + 0.2; // 0.30000000000000004
      expect(Money.round2(floatDrift)).toBe(0.3);
      expect(Money.round2(10.005)).toBe(10.01);
      expect(Money.round4(10.12345)).toBe(10.1235);
    });

    test("adds and subtracts without floating point corruption", () => {
      expect(Money.add(0.1, 0.2)).toBe(0.3);
      expect(Money.add("12.50", "3.75", 4.25)).toBe(20.5);
      expect(Money.subtract(100.5, 45.25)).toBe(55.25);
    });
  });

  describe("calculateGstSplit", () => {
    test("calculates 12% intra-state GST with 50/50 CGST & SGST split", () => {
      const split = Money.calculateGstSplit(100, 12, false);
      expect(split.taxableAmount).toBe(100);
      expect(split.gstRate).toBe(12);
      expect(split.gstAmount).toBe(12);
      expect(split.cgst).toBe(6);
      expect(split.sgst).toBe(6);
      expect(split.igst).toBe(0);
      expect(split.grossAmount).toBe(112);
    });

    test("calculates 18% inter-state GST with 100% IGST", () => {
      const split = Money.calculateGstSplit(200, 18, true);
      expect(split.taxableAmount).toBe(200);
      expect(split.gstRate).toBe(18);
      expect(split.gstAmount).toBe(36);
      expect(split.cgst).toBe(0);
      expect(split.sgst).toBe(0);
      expect(split.igst).toBe(36);
      expect(split.grossAmount).toBe(236);
    });

    test("handles zero tax items (0% GST)", () => {
      const split = Money.calculateGstSplit(150, 0, false);
      expect(split.gstAmount).toBe(0);
      expect(split.cgst).toBe(0);
      expect(split.sgst).toBe(0);
      expect(split.grossAmount).toBe(150);
    });

    test("handles odd paise GST splits deterministically", () => {
      // 12% of 45.25 = 5.43 GST -> CGST = 2.72, SGST = 2.71 (or sum equals 5.43 exactly)
      const split = Money.calculateGstSplit(45.25, 12, false);
      expect(split.gstAmount).toBe(5.43);
      expect(Money.add(split.cgst, split.sgst)).toBe(5.43);
    });
  });

  describe("calculateLineItem", () => {
    test("calculates item with line discount and GST", () => {
      const line = Money.calculateLineItem({
        quantity: 2,
        unitPrice: 100,
        discountPct: 10, // 10% discount on 200 = 20 -> taxable = 180
        gstRate: 12, // 12% on 180 = 21.60
        isInterstate: false,
      });

      expect(line.quantity).toBe(2);
      expect(line.unitPrice).toBe(100);
      expect(line.discountAmount).toBe(20);
      expect(line.taxableAmount).toBe(180);
      expect(line.gstAmount).toBe(21.6);
      expect(line.cgst).toBe(10.8);
      expect(line.sgst).toBe(10.8);
      expect(line.total).toBe(201.6);
    });
  });

  describe("calculateGrandTotal", () => {
    test("computes multi-item invoice with bill-level discount and balance due", () => {
      const summary = Money.calculateGrandTotal({
        items: [
          { quantity: 2, unitPrice: 50, discountPct: 0, gstRate: 12 }, // 100 + 12 GST = 112
          { quantity: 1, unitPrice: 200, discountPct: 5, gstRate: 18 }, // 190 + 34.20 GST = 224.20
        ],
        billDiscount: 10, // flat 10 discount
        paidAmount: 300,
      });

      expect(summary.subtotal).toBe(300);
      expect(summary.totalGst).toBe(46.2);
      expect(summary.grandTotal).toBe(326.2);
      expect(summary.paidAmount).toBe(300);
      expect(summary.balanceDue).toBe(26.2);
    });
  });

  describe("calculateBlendedPurchasePrice", () => {
    test("computes weighted-average blended unit cost accurately", () => {
      // 10 units @ 50 + 20 units @ 80 = (500 + 1600) / 30 = 2100 / 30 = 70.0000
      const blended = Money.calculateBlendedPurchasePrice({
        existingQuantity: 10,
        existingPurchasePrice: 50,
        newQuantity: 20,
        newPurchasePrice: 80,
      });
      expect(blended).toBe(70);
    });
  });
});

describe("Tax-inclusive POS prices", () => {
  test("extracts tax without increasing the displayed price", () => {
    const item = Money.calculateLineItem({
      quantity: 1,
      unitPrice: 20,
      gstRate: 12,
      discountPct: 10,
      priceIncludesTax: true,
    });
    expect(item.total).toBe(18);
    expect(Money.add(item.taxableAmount, item.gstAmount)).toBe(18);
    expect(Money.add(item.cgst, item.sgst)).toBe(item.gstAmount);
    const total = Money.calculateGrandTotal({
      items: [{ quantity: 1, unitPrice: 20, gstRate: 12, discountPct: 10 }],
      paidAmount: 10,
      priceIncludesTax: true,
    });
    expect(total.grandTotal).toBe(18);
    expect(total.balanceDue).toBe(8);
  });
});

test("inclusive bill discount reduces its embedded tax and allows a fully discounted bill", () => {
  const summary = Money.calculateGrandTotal({
    items: [{ quantity: 1, unitPrice: 20, gstRate: 12 }],
    billDiscount: 2,
    priceIncludesTax: true,
  });
  expect(summary.grandTotal).toBe(18);
  expect(summary.totalGst).toBe(1.93);
  expect(Money.add(summary.taxableSubtotal, summary.totalGst)).toBe(18);
  expect(
    Money.calculateGrandTotal({
      items: [{ quantity: 1, unitPrice: 20, gstRate: 12 }],
      billDiscount: 20,
      priceIncludesTax: true,
    }).grandTotal,
  ).toBe(0);
});
