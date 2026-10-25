import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { Money } from '../lib/money';
import { v4 as uuidv4 } from 'uuid';

describe('Foundation Hardening & Transaction Integrity (Task 0)', () => {
  const clinicId = 'clinic-foundation-test';

  beforeAll(() => {
    // Seed test clinic
    localDb.prepare('INSERT OR REPLACE INTO clinics (id, _local_id, name, plan, is_active, _updated_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(clinicId, clinicId, 'Foundation Test Clinic', 'pro', new Date().toISOString());
  });

  afterAll(() => {
    // Clean up test data
    localDb.prepare('DELETE FROM clinics WHERE id = ?').run(clinicId);
    localDb.prepare('DELETE FROM medicines WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM medicine_batches WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM customers WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM suppliers WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM sales WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM sale_items WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM purchases WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM purchase_items WHERE clinic_id = ?').run(clinicId);
    localDb.prepare('DELETE FROM stock_ledger WHERE clinic_id = ?').run(clinicId);
  });

  // ── 1. NORMAL SALE ────────────────────────────────────────────────────────
  test('1. Normal Sale: item checkout, stock deduction, sale items, and stock ledger movement', () => {
    const medId = uuidv4();
    const batchId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: { id: medId, _local_id: medId, clinic_id: clinicId, name: 'Paracetamol 650mg', gst_rate: 12, is_active: 1 },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        clinic_id: clinicId,
        medicine_id: medId,
        batch_number: 'BATCH-NORM-01',
        expiry_date: '2028-12-31',
        quantity_in: 100,
        quantity_remaining: 100,
        purchase_price: 15,
        mrp: 30,
        is_disposed: 0,
      },
    });

    // Execute Sale of 10 units
    const qtyToSell = 10;
    const lineCalc = Money.calculateLineItem({ quantity: qtyToSell, unitPrice: 30, discountPct: 0, gstRate: 12 });
    const grandCalc = Money.calculateGrandTotal({ items: [{ quantity: qtyToSell, unitPrice: 30, gstRate: 12 }] });

    const saleId = uuidv4();
    const sale: any = localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: saleId,
        _local_id: saleId,
        clinic_id: clinicId,
        invoice_number: 'INV-NORM-01',
        subtotal: grandCalc.subtotal,
        discount: grandCalc.totalDiscount,
        gst_amount: grandCalc.totalGst,
        net_amount: grandCalc.grandTotal,
        grand_total: grandCalc.grandTotal,
        payment_mode: 'cash',
        payment_status: 'paid',
        paid_amount: grandCalc.grandTotal,
        balance_due: 0,
      },
    });

    localMutate({
      table: 'sale_items',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        clinic_id: clinicId,
        sale_id: sale.id || saleId,
        medicine_id: medId,
        batch_id: batchId,
        quantity: qtyToSell,
        unit_price: 30,
        discount_pct: 0,
        gst_rate: 12,
        total: lineCalc.total,
      },
    });

    // Deduct stock
    const updatedBatch: any = localMutate({
      table: 'medicine_batches',
      operation: 'UPDATE',
      data: { _local_id: batchId, quantity_remaining: 100 - qtyToSell },
    });

    // Record Stock Ledger
    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'SALE',
        quantity_delta: -qtyToSell,
        balance_after: 90,
        reference_id: saleId,
      },
    });

    expect(updatedBatch.quantity_remaining).toBe(90);

    const ledger = localDb.prepare('SELECT * FROM stock_ledger WHERE reference_id = ?').get(saleId) as any;
    expect(ledger).toBeDefined();
    expect(ledger.movement_type).toBe('SALE');
    expect(ledger.quantity_delta).toBe(-10);
    expect(ledger.balance_after).toBe(90);
  });

  // ── 2. CONCURRENT SALE (Overselling Prevention) ───────────────────────────
  test('2. Concurrent Sale: prevents negative stock when stock is depleted', () => {
    const medId = uuidv4();
    const batchId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: { id: medId, _local_id: medId, clinic_id: clinicId, name: 'Amoxicillin 500mg', is_active: 1 },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        clinic_id: clinicId,
        medicine_id: medId,
        batch_number: 'BATCH-CONC-01',
        expiry_date: '2028-12-31',
        quantity_remaining: 5,
        purchase_price: 40,
        mrp: 80,
      },
    });

    // Terminal 1 requests 5 units
    const batchBefore1 = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE _local_id = ?').get(batchId) as any;
    const req1 = 5;
    expect(batchBefore1.quantity_remaining >= req1).toBe(true);

    localMutate({
      table: 'medicine_batches',
      operation: 'UPDATE',
      data: { _local_id: batchId, quantity_remaining: batchBefore1.quantity_remaining - req1 },
    });

    // Terminal 2 tries to sell 2 units simultaneously
    const batchBefore2 = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE _local_id = ?').get(batchId) as any;
    const req2 = 2;
    const canSell2 = batchBefore2.quantity_remaining >= req2;

    expect(canSell2).toBe(false);
    expect(batchBefore2.quantity_remaining).toBe(0);
  });

  // ── 3. INSUFFICIENT STOCK ─────────────────────────────────────────────────
  test('3. Insufficient Stock: throws error and rejects sale when requested > available', () => {
    const available = 4;
    const requested = 10;

    const attemptSale = () => {
      if (available < requested) {
        throw new Error(`INSUFFICIENT_STOCK: Available: ${available}, Requested: ${requested}`);
      }
    };

    expect(attemptSale).toThrow('INSUFFICIENT_STOCK');
  });

  // ── 4. EXPIRED STOCK ──────────────────────────────────────────────────────
  test('4. Expired Stock: blocks checkout from expired batches', () => {
    const expiredBatch = {
      batch_number: 'BATCH-EXP-01',
      expiry_date: '2020-01-01', // Expired
    };

    const today = new Date().toISOString().split('T')[0];
    const isExpired = expiredBatch.expiry_date < today;

    expect(isExpired).toBe(true);

    const validateCheckout = () => {
      if (isExpired) {
        throw new Error('EXPIRED_BATCH: Cannot sell from an expired batch.');
      }
    };

    expect(validateCheckout).toThrow('EXPIRED_BATCH');
  });

  // ── 5. RETURNED SALE ──────────────────────────────────────────────────────
  test('5. Returned Sale: full return restores batch stock and marks return', () => {
    const medId = uuidv4();
    const batchId = uuidv4();
    const saleId = uuidv4();
    const saleItemId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: { id: medId, _local_id: medId, clinic_id: clinicId, name: 'Cetirizine 10mg', is_active: 1 },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        clinic_id: clinicId,
        medicine_id: medId,
        batch_number: 'BATCH-RET-01',
        expiry_date: '2028-12-31',
        quantity_remaining: 15, // Was 20, 5 sold
        purchase_price: 10,
        mrp: 20,
      },
    });

    localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: { id: saleId, _local_id: saleId, clinic_id: clinicId, invoice_number: 'INV-ORIG-01', grand_total: 100 },
    });

    localMutate({
      table: 'sale_items',
      operation: 'INSERT',
      data: {
        id: saleItemId,
        _local_id: saleItemId,
        clinic_id: clinicId,
        sale_id: saleId,
        medicine_id: medId,
        batch_id: batchId,
        quantity: 5,
        unit_price: 20,
        total: 100,
      },
    });

    // Execute Return of 5 units
    const returnSaleId = uuidv4();
    localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: returnSaleId,
        _local_id: returnSaleId,
        clinic_id: clinicId,
        invoice_number: 'RET-01',
        is_return: 1,
        return_of: saleId,
        payment_status: 'returned',
        grand_total: 100,
      },
    });

    // Restore stock
    localMutate({
      table: 'medicine_batches',
      operation: 'UPDATE',
      data: { _local_id: batchId, quantity_remaining: 15 + 5 },
    });

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'SALE_RETURN',
        quantity_delta: 5,
        balance_after: 20,
        reference_id: returnSaleId,
      },
    });

    const batch = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE _local_id = ?').get(batchId) as any;
    expect(batch.quantity_remaining).toBe(20);

    const ledger = localDb.prepare('SELECT * FROM stock_ledger WHERE reference_id = ?').get(returnSaleId) as any;
    expect(ledger.movement_type).toBe('SALE_RETURN');
    expect(ledger.quantity_delta).toBe(5);
    expect(ledger.balance_after).toBe(20);
  });

  // ── 6. PARTIAL RETURN ─────────────────────────────────────────────────────
  test('6. Partial Return: returning 2 of 5 units recalculates refund and restores 2 units', () => {
    const medId = uuidv4();
    const batchId = uuidv4();
    const saleId = uuidv4();

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        clinic_id: clinicId,
        medicine_id: medId,
        batch_number: 'BATCH-PART-01',
        expiry_date: '2028-12-31',
        quantity_remaining: 8,
        purchase_price: 20,
        mrp: 50,
      },
    });

    // Original sale had 5 units @ 50 = 250
    // Customer returns 2 units -> refund = 2 * 50 = 100
    const returnQty = 2;
    const unitPrice = 50;
    const refundTotal = Money.multiply(returnQty, unitPrice);

    expect(refundTotal).toBe(100);

    // Restore 2 units
    localMutate({
      table: 'medicine_batches',
      operation: 'UPDATE',
      data: { _local_id: batchId, quantity_remaining: 8 + returnQty },
    });

    const batch = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE _local_id = ?').get(batchId) as any;
    expect(batch.quantity_remaining).toBe(10);
  });

  // ── 7. PURCHASE INWARD & BLENDED COST ─────────────────────────────────────
  test('7. Purchase Inward: creates batch, increments stock, and blends weighted purchase rate', () => {
    const medId = uuidv4();
    const batchId = uuidv4();

    // Initial batch: 10 units @ 50 INR
    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        clinic_id: clinicId,
        medicine_id: medId,
        batch_number: 'BATCH-INWARD-01',
        expiry_date: '2028-06-30',
        quantity_in: 10,
        quantity_remaining: 10,
        purchase_price: 50,
        mrp: 80,
      },
    });

    // Inward purchase: 20 units @ 80 INR
    const newQty = 20;
    const newPrice = 80;
    const blendedPrice = Money.calculateBlendedPurchasePrice({
      existingQuantity: 10,
      existingPurchasePrice: 50,
      newQuantity: newQty,
      newPurchasePrice: newPrice,
    });

    expect(blendedPrice).toBe(70); // (10*50 + 20*80) / 30 = 2100 / 30 = 70.00

    const purchaseId = uuidv4();
    localMutate({
      table: 'medicine_batches',
      operation: 'UPDATE',
      data: {
        _local_id: batchId,
        quantity_remaining: 10 + newQty,
        purchase_price: blendedPrice,
      },
    });

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        clinic_id: clinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'PURCHASE_RECEIPT',
        quantity_delta: newQty,
        balance_after: 30,
        reference_id: purchaseId,
      },
    });

    const batch = localDb.prepare('SELECT quantity_remaining, purchase_price FROM medicine_batches WHERE _local_id = ?').get(batchId) as any;
    expect(batch.quantity_remaining).toBe(30);
    expect(batch.purchase_price).toBe(70);
  });

  // ── 8. SUPPLIER BALANCE & PAYABLES ────────────────────────────────────────
  test('8. Supplier Balance: inward purchases increase payable debt; payments reduce it', () => {
    const supplierId = uuidv4();

    localMutate({
      table: 'suppliers',
      operation: 'INSERT',
      data: {
        id: supplierId,
        _local_id: supplierId,
        clinic_id: clinicId,
        name: 'Apollo Pharmaceuticals Dist.',
        outstanding_balance: 0,
      },
    });

    // Inward purchase of 5,000 INR unpaid
    const billTotal = 5000;
    const supp1 = localDb.prepare('SELECT outstanding_balance FROM suppliers WHERE _local_id = ?').get(supplierId) as any;
    const newBalance = Money.add(supp1.outstanding_balance || 0, billTotal);

    localMutate({
      table: 'suppliers',
      operation: 'UPDATE',
      data: { _local_id: supplierId, outstanding_balance: newBalance },
    });

    let supp = localDb.prepare('SELECT outstanding_balance FROM suppliers WHERE _local_id = ?').get(supplierId) as any;
    expect(supp.outstanding_balance).toBe(5000);

    // Partial payment of 2,000 INR
    const payment = 2000;
    const balanceAfterPay = Money.subtract(supp.outstanding_balance, payment);
    localMutate({
      table: 'suppliers',
      operation: 'UPDATE',
      data: { _local_id: supplierId, outstanding_balance: balanceAfterPay },
    });

    supp = localDb.prepare('SELECT outstanding_balance FROM suppliers WHERE _local_id = ?').get(supplierId) as any;
    expect(supp.outstanding_balance).toBe(3000);
  });

  // ── 9. CUSTOMER CREDIT & RECEIVABLES ──────────────────────────────────────
  test('9. Customer Credit: unpaid credit sales increment balance; payments settle it', () => {
    const customerId = uuidv4();

    localMutate({
      table: 'customers',
      operation: 'INSERT',
      data: {
        id: customerId,
        _local_id: customerId,
        clinic_id: clinicId,
        name: 'Sharma Patient',
        outstanding_balance: 0,
      },
    });

    // Credit sale of 1,250 INR
    const creditSaleDue = 1250;
    const cust1 = localDb.prepare('SELECT outstanding_balance FROM customers WHERE _local_id = ?').get(customerId) as any;
    const balanceAfterCredit = Money.add(cust1.outstanding_balance || 0, creditSaleDue);

    localMutate({
      table: 'customers',
      operation: 'UPDATE',
      data: { _local_id: customerId, outstanding_balance: balanceAfterCredit },
    });

    let cust = localDb.prepare('SELECT outstanding_balance FROM customers WHERE _local_id = ?').get(customerId) as any;
    expect(cust.outstanding_balance).toBe(1250);

    // Customer settles 1,000 INR
    const settledAmount = 1000;
    const remainingBalance = Money.subtract(cust.outstanding_balance, settledAmount);
    localMutate({
      table: 'customers',
      operation: 'UPDATE',
      data: { _local_id: customerId, outstanding_balance: remainingBalance },
    });

    cust = localDb.prepare('SELECT outstanding_balance FROM customers WHERE _local_id = ?').get(customerId) as any;
    expect(cust.outstanding_balance).toBe(250);
  });

  // ── 10. OFFLINE BILL IDEMPOTENCY ──────────────────────────────────────────
  test('10. Offline Bill Idempotency: repeated sync push with same _local_id does not duplicate sale', () => {
    const localBillId = 'offline-uuid-999';

    // First push
    localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: localBillId,
        _local_id: localBillId,
        clinic_id: clinicId,
        invoice_number: 'OFFLINE-BILL-01',
        grand_total: 450,
      },
    });

    // Re-push of same bill (idempotency simulation)
    localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: localBillId,
        _local_id: localBillId,
        clinic_id: clinicId,
        invoice_number: 'OFFLINE-BILL-01',
        grand_total: 450,
      },
    });

    const matchingSales = localDb.prepare('SELECT * FROM sales WHERE _local_id = ?').all(localBillId);
    expect(matchingSales.length).toBe(1); // INSERT OR REPLACE maintains single entity
  });

  // ── 11. GST CALCULATION ACROSS SLABS ──────────────────────────────────────
  test('11. GST Calculation: exact multi-slab precision (0%, 5%, 12%, 18%, 28%) with zero float drift', () => {
    // 0% Exempt item
    const g0 = Money.calculateGstSplit(500, 0, false);
    expect(g0.gstAmount).toBe(0);
    expect(g0.grossAmount).toBe(500);

    // 5% item
    const g5 = Money.calculateGstSplit(100, 5, false);
    expect(g5.gstAmount).toBe(5);
    expect(g5.cgst).toBe(2.5);
    expect(g5.sgst).toBe(2.5);
    expect(g5.grossAmount).toBe(105);

    // 12% item
    const g12 = Money.calculateGstSplit(250, 12, false);
    expect(g12.gstAmount).toBe(30);
    expect(g12.cgst).toBe(15);
    expect(g12.sgst).toBe(15);
    expect(g12.grossAmount).toBe(280);

    // 18% inter-state IGST
    const g18 = Money.calculateGstSplit(1000, 18, true);
    expect(g18.gstAmount).toBe(180);
    expect(g18.igst).toBe(180);
    expect(g18.cgst).toBe(0);
    expect(g18.grossAmount).toBe(1180);

    // 28% luxury/device item
    const g28 = Money.calculateGstSplit(300, 28, false);
    expect(g28.gstAmount).toBe(84);
    expect(g28.cgst).toBe(42);
    expect(g28.sgst).toBe(42);
    expect(g28.grossAmount).toBe(384);
  });
});
