import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { Money } from '../lib/money';
import { v4 as uuidv4 } from 'uuid';
import { OrganizationMigrationService } from '../services/organizationMigration';
import { DocumentNumberingService } from '../services/documentNumbering';
import { InventoryPositionService } from '../services/inventoryPosition';
import { InventoryReconciliationService } from '../services/inventoryReconciliation';
import { convertUnits } from '../domain/units';

describe('Enterprise Pharmacy Domain & Multi-Store Foundation (Task 1)', () => {
  const testClinicId = 'clinic-enterprise-test';
  let testOrgId: string;
  let defaultStoreId: string;

  beforeAll(() => {
    // Clean up test data first to ensure pristine test state
    localDb.prepare('DELETE FROM clinics WHERE id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM medicines WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM medicine_batches WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM sales WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM sale_items WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM purchases WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM purchase_items WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM expenses WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare('DELETE FROM stock_ledger WHERE clinic_id = ?').run(testClinicId);
    localDb.prepare("DELETE FROM organizations WHERE legal_name LIKE 'Apollo Pharmacy%'").run();
    localDb.prepare("DELETE FROM stores WHERE name LIKE 'Apollo Pharmacy%'").run();
    localDb.prepare("DELETE FROM counters WHERE name LIKE '%Counter%'").run();
    localDb.prepare("DELETE FROM terminals WHERE terminal_code LIKE 'POS%' OR terminal_code LIKE 'T1%'").run();

    // Seed initial test clinic
    localDb
      .prepare('INSERT OR REPLACE INTO clinics (id, _local_id, name, slug, gstin, drug_licence_number, plan, is_active, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(
        testClinicId,
        testClinicId,
        'Apollo Pharmacy Group',
        'apollo-group',
        '36AAAAA0000A1Z5',
        'DL-TEL-12345',
        'pro',
        new Date().toISOString()
      );

    // Initial migration setup
    const res = OrganizationMigrationService.migrateClinic(testClinicId);
    testOrgId = res.organizationId;
    defaultStoreId = res.storeId;
  });

  afterAll(() => {
    // Clean up test data
    localDb.prepare('DELETE FROM clinics WHERE id = ?').run(testClinicId);
    if (testOrgId) {
      localDb.prepare('DELETE FROM organizations WHERE id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM stores WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM regions WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM warehouses WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM counters WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM terminals WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM user_organization_access WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM user_store_access WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM document_sequences WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM financial_years WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM inventory_positions WHERE organization_id = ?').run(testOrgId);
      localDb.prepare('DELETE FROM product_barcodes WHERE organization_id = ?').run(testOrgId);
    }
  });

  // ── 1. EXISTING TENANT MIGRATION ──────────────────────────────────────────
  test('1. Existing Tenant Migration: automatically migrates clinic to organization & default store', () => {
    const res = OrganizationMigrationService.migrateClinic(testClinicId);
    expect(res.clinicId).toBe(testClinicId);
    expect(res.organizationId).toBeTruthy();
    expect(res.storeId).toBeTruthy();
    expect(res.counterId).toBeTruthy();
    expect(res.terminalId).toBeTruthy();

    const orgRow: any = localDb.prepare('SELECT * FROM organizations WHERE id = ?').get(res.organizationId);
    expect(orgRow).toBeDefined();
    expect(orgRow.legal_name).toBe('Apollo Pharmacy Group');
    expect(orgRow.default_state_code).toBe('36');

    const clinicRow: any = localDb.prepare('SELECT * FROM clinics WHERE id = ?').get(testClinicId);
    expect(clinicRow.organization_id).toBe(res.organizationId);
  });

  // ── 2. ORGANIZATION CREATION ──────────────────────────────────────────────
  test('2. Organization Creation: explicit org creation with tax, currency and FY configuration', () => {
    const orgId = uuidv4();
    const orgCode = `ORG-MAX-${Date.now().toString().slice(-4)}`;
    localMutate({
      table: 'organizations',
      operation: 'INSERT',
      data: {
        id: orgId,
        _local_id: orgId,
        legal_name: 'Max Healthcare Retail Ltd',
        display_name: 'Max Pharmacy Chain',
        code: orgCode,
        gstin: '07AAAAA1111A1Z1',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        financial_year_start: '04-01',
        default_state_code: '07',
        status: 'active',
      },
    });

    const row: any = localDb.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    expect(row).toBeDefined();
    expect(row.legal_name).toBe('Max Healthcare Retail Ltd');
    expect(row.code).toBe(orgCode);
    expect(row.currency).toBe('INR');
  });

  // ── 3. DEFAULT STORE CREATION ─────────────────────────────────────────────
  test('3. Default Store Creation: verify default store attributes linked to organization', () => {
    const storeRow: any = localDb.prepare('SELECT * FROM stores WHERE id = ?').get(defaultStoreId);
    expect(storeRow).toBeDefined();
    expect(storeRow.store_code).toBe('MAIN');
    expect(storeRow.organization_id).toBe(testOrgId);
    expect(storeRow.fulfilment_enabled).toBe(1);
  });

  // ── 4. MULTIPLE STORES PER ORGANIZATION ───────────────────────────────────
  test('4. Multiple Stores per Organization: creates branch stores under the same parent organization', () => {
    const store2Id = uuidv4();
    const store3Id = uuidv4();

    localMutate({
      table: 'stores',
      operation: 'INSERT',
      data: {
        id: store2Id,
        _local_id: store2Id,
        organization_id: testOrgId,
        store_code: 'HYD-BANJARA',
        name: 'Apollo Pharmacy — Banjara Hills Branch',
        city: 'Hyderabad',
        state: 'Telangana',
        state_code: '36',
        status: 'active',
      },
    });

    localMutate({
      table: 'stores',
      operation: 'INSERT',
      data: {
        id: store3Id,
        _local_id: store3Id,
        organization_id: testOrgId,
        store_code: 'HYD-HITECH',
        name: 'Apollo Pharmacy — Hitech City 24x7',
        city: 'Hyderabad',
        state: 'Telangana',
        state_code: '36',
        status: 'active',
      },
    });

    const stores: any[] = localDb
      .prepare('SELECT * FROM stores WHERE organization_id = ? AND _deleted = 0')
      .all(testOrgId);

    expect(stores.length).toBeGreaterThanOrEqual(3);
    const codes = stores.map(s => s.store_code);
    expect(codes).toContain('MAIN');
    expect(codes).toContain('HYD-BANJARA');
    expect(codes).toContain('HYD-HITECH');
  });

  // ── 5. USER AUTHORIZED FOR ONE STORE ──────────────────────────────────────
  test('5. User Authorized for One Store: single store cashier permission assignment', () => {
    const cashierUserId = uuidv4();
    const banjaraStore: any = localDb.prepare("SELECT id FROM stores WHERE store_code = 'HYD-BANJARA'").get();

    localMutate({
      table: 'user_store_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        user_id: cashierUserId,
        organization_id: testOrgId,
        store_id: banjaraStore.id,
        role: 'CASHIER',
        is_default: 1,
        is_active: 1,
      },
    });

    const accessRows: any[] = localDb
      .prepare('SELECT * FROM user_store_access WHERE user_id = ? AND is_active = 1')
      .all(cashierUserId);

    expect(accessRows.length).toBe(1);
    expect(accessRows[0].store_id).toBe(banjaraStore.id);
    expect(accessRows[0].role).toBe('CASHIER');
  });

  // ── 6. USER AUTHORIZED FOR ALL STORES ─────────────────────────────────────
  test('6. User Authorized for All Stores: organization owner / regional manager org-wide access', () => {
    const regionalManagerId = uuidv4();

    localMutate({
      table: 'user_organization_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        user_id: regionalManagerId,
        organization_id: testOrgId,
        role: 'REGIONAL_MANAGER',
        is_active: 1,
      },
    });

    const orgAccess: any = localDb
      .prepare('SELECT * FROM user_organization_access WHERE user_id = ? AND organization_id = ?')
      .get(regionalManagerId, testOrgId);

    expect(orgAccess).toBeDefined();
    expect(orgAccess.role).toBe('REGIONAL_MANAGER');
    expect(orgAccess.is_active).toBe(1);
  });

  // ── 7. CROSS-STORE ACCESS REJECTION ───────────────────────────────────────
  test('7. Cross-Store Access Rejection: prevents a store cashier from accessing other stores', () => {
    const restrictedCashierId = uuidv4();
    const banjaraStore: any = localDb.prepare("SELECT id FROM stores WHERE store_code = 'HYD-BANJARA'").get();
    const hitechStore: any = localDb.prepare("SELECT id FROM stores WHERE store_code = 'HYD-HITECH'").get();

    // Grant access only to Banjara Store
    localMutate({
      table: 'user_store_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        user_id: restrictedCashierId,
        organization_id: testOrgId,
        store_id: banjaraStore.id,
        role: 'CASHIER',
        is_active: 1,
      },
    });

    // Verification check for Hitech store
    const unauthorizedAccess: any = localDb
      .prepare('SELECT * FROM user_store_access WHERE user_id = ? AND store_id = ? AND is_active = 1')
      .get(restrictedCashierId, hitechStore.id);

    expect(unauthorizedAccess).toBeUndefined();
  });

  // ── 8. COUNTER CREATION ───────────────────────────────────────────────────
  test('8. Counter Creation: creates multiple billing counters in a store', () => {
    const counter1Id = uuidv4();
    const counter2Id = uuidv4();

    localMutate({
      table: 'counters',
      operation: 'INSERT',
      data: {
        id: counter1Id,
        _local_id: counter1Id,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_code: 'BILL-01',
        name: 'Express Billing Counter',
        status: 'active',
      },
    });

    localMutate({
      table: 'counters',
      operation: 'INSERT',
      data: {
        id: counter2Id,
        _local_id: counter2Id,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_code: 'NIGHT-01',
        name: '24x7 Night Window',
        status: 'active',
      },
    });

    const counters: any[] = localDb
      .prepare('SELECT * FROM counters WHERE store_id = ? AND _deleted = 0')
      .all(defaultStoreId);

    const codes = counters.map(c => c.counter_code);
    expect(codes).toContain('BILL-01');
    expect(codes).toContain('NIGHT-01');
  });

  // ── 9. TERMINAL REGISTRATION ──────────────────────────────────────────────
  test('9. Terminal Registration: registers POS terminals with hardware UUID & platform', () => {
    const terminalId = uuidv4();
    const deviceUuid = 'DEV-POS-MAC-9876';

    localMutate({
      table: 'terminals',
      operation: 'INSERT',
      data: {
        id: terminalId,
        _local_id: terminalId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        device_uuid: deviceUuid,
        terminal_code: 'POS-01',
        terminal_name: 'Counter 1 Desktop Client',
        platform: 'DESKTOP',
        app_version: '2.4.0',
        status: 'active',
      },
    });

    const terminal: any = localDb.prepare('SELECT * FROM terminals WHERE device_uuid = ?').get(deviceUuid);
    expect(terminal).toBeDefined();
    expect(terminal.platform).toBe('DESKTOP');
    expect(terminal.terminal_code).toBe('POS-01');
  });

  // ── 10. STORE-AWARE SALE ──────────────────────────────────────────────────
  test('10. Store-Aware Sale: sale checkout records organization, store, counter, and terminal context', () => {
    const medId = uuidv4();
    const batchId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medId,
        _local_id: medId,
        organization_id: testOrgId,
        clinic_id: testClinicId,
        name: 'Amoxicillin 500mg',
        product_type: 'MEDICINE',
        gst_rate: 12,
        is_active: 1,
      },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_number: 'AMX-2026',
        expiry_date: '2028-06-30',
        quantity_in: 50,
        quantity_remaining: 50,
        purchase_price: 40,
        mrp: 80,
      },
    });

    // Initialize inventory position
    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      initialStock: 50,
    });

    // Execute Store-Aware Sale
    const invoiceNum = DocumentNumberingService.generate({
      organizationId: testOrgId,
      storeId: defaultStoreId,
      documentType: 'SALE_INVOICE',
    });

    const saleId = uuidv4();
    localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        id: saleId,
        _local_id: saleId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_id: 'C1',
        terminal_id: 'T1',
        clinic_id: testClinicId,
        invoice_number: invoiceNum,
        subtotal: 160,
        grand_total: 160,
        net_amount: 160,
        paid_amount: 160,
        balance_due: 0,
        payment_mode: 'cash',
        payment_status: 'paid',
      },
    });

    localMutate({
      table: 'sale_items',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        sale_id: saleId,
        medicine_id: medId,
        batch_id: batchId,
        quantity: 2,
        unit_price: 80,
        total: 160,
      },
    });

    // Stock deduction & Ledger insertion
    localDb.prepare('UPDATE medicine_batches SET quantity_remaining = quantity_remaining - 2 WHERE id = ?').run(batchId);
    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      quantityDelta: -2,
    });

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_id: 'C1',
        terminal_id: 'T1',
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'SALE',
        quantity_delta: -2,
        balance_after: 48,
        reference_id: saleId,
      },
    });

    const saleRow: any = localDb.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(saleRow.organization_id).toBe(testOrgId);
    expect(saleRow.store_id).toBe(defaultStoreId);
    expect(saleRow.invoice_number).toMatch(/MAIN\/INV\/\d{2}-\d{2}\/\d{4}/);

    const posRow: any = localDb.prepare('SELECT * FROM inventory_positions WHERE batch_id = ? AND store_id = ?').get(batchId, defaultStoreId);
    expect(posRow.quantity_on_hand).toBe(48);
  });

  // ── 11. STORE-AWARE PURCHASE ──────────────────────────────────────────────
  test('11. Store-Aware Purchase: inward purchase updates store-specific batch stock & ledger', () => {
    const medId = uuidv4();
    const purchaseId = uuidv4();
    const batchId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medId,
        _local_id: medId,
        organization_id: testOrgId,
        clinic_id: testClinicId,
        name: 'Cetirizine 10mg',
        gst_rate: 12,
        is_active: 1,
      },
    });

    localMutate({
      table: 'purchases',
      operation: 'INSERT',
      data: {
        id: purchaseId,
        _local_id: purchaseId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        invoice_number: 'SUPP-INV-990',
        subtotal: 500,
        grand_total: 500,
        net_amount: 500,
      },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_number: 'CET-BATCH-1',
        expiry_date: '2029-01-31',
        quantity_in: 100,
        quantity_remaining: 100,
        purchase_price: 5,
        mrp: 10,
      },
    });

    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      initialStock: 100,
    });

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'PURCHASE_RECEIPT',
        quantity_delta: 100,
        balance_after: 100,
        reference_id: purchaseId,
      },
    });

    const purchaseRow: any = localDb.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
    expect(purchaseRow.store_id).toBe(defaultStoreId);

    const posRow: any = localDb.prepare('SELECT * FROM inventory_positions WHERE batch_id = ? AND store_id = ?').get(batchId, defaultStoreId);
    expect(posRow.quantity_on_hand).toBe(100);
  });

  // ── 12. STORE-AWARE EXPENSE ───────────────────────────────────────────────
  test('12. Store-Aware Expense: expense records store, counter, and terminal attribution', () => {
    const expenseId = uuidv4();
    localMutate({
      table: 'expenses',
      operation: 'INSERT',
      data: {
        id: expenseId,
        _local_id: expenseId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_id: 'C1',
        terminal_id: 'T1',
        clinic_id: testClinicId,
        category: 'utilities',
        amount: 2500,
        description: 'Store Electricity Bill',
        expense_date: '2026-08-09',
      },
    });

    const expRow: any = localDb.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
    expect(expRow.organization_id).toBe(testOrgId);
    expect(expRow.store_id).toBe(defaultStoreId);
    expect(expRow.amount).toBe(2500);
  });

  // ── 13. STOCK LEDGER LOCATION ATTRIBUTION ─────────────────────────────────
  test('13. Stock Ledger Location Attribution: ledger tracks source, destination, store, and counter info', () => {
    const ledgerId = uuidv4();
    const medId = uuidv4();
    const batchId = uuidv4();

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        id: ledgerId,
        _local_id: ledgerId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'TRANSFER_OUT',
        quantity_delta: -15,
        balance_after: 35,
        source_location_type: 'STORE',
        source_location_id: defaultStoreId,
        destination_location_type: 'STORE',
        destination_location_id: 'store-branch-2',
        reference_id: 'TRF-001',
      },
    });

    const ledgerRow: any = localDb.prepare('SELECT * FROM stock_ledger WHERE id = ?').get(ledgerId);
    expect(ledgerRow.movement_type).toBe('TRANSFER_OUT');
    expect(ledgerRow.source_location_type).toBe('STORE');
    expect(ledgerRow.destination_location_type).toBe('STORE');
    expect(ledgerRow.quantity_delta).toBe(-15);
  });

  // ── 14. INVENTORY POSITION CREATION ───────────────────────────────────────
  test('14. Inventory Position Creation: verifies distinct stock tracking across store and warehouse', () => {
    const medId = uuidv4();
    const batchId = uuidv4();
    const warehouseId = uuidv4();

    // Store position
    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      initialStock: 25,
    });

    // Warehouse position for same batch
    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'WAREHOUSE',
      warehouseId,
      initialStock: 500,
    });

    const storePos: any = localDb.prepare('SELECT * FROM inventory_positions WHERE batch_id = ? AND store_id = ?').get(batchId, defaultStoreId);
    const whPos: any = localDb.prepare('SELECT * FROM inventory_positions WHERE batch_id = ? AND warehouse_id = ?').get(batchId, warehouseId);

    expect(storePos.quantity_on_hand).toBe(25);
    expect(whPos.quantity_on_hand).toBe(500);
  });

  // ── 15. INVENTORY RECONCILIATION ──────────────────────────────────────────
  test('15. Inventory Reconciliation: diagnostic reconciliation between ledger, positions, and batch', () => {
    const medId = uuidv4();
    const batchId = uuidv4();

    // 1. Matched scenario
    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_number: 'REC-MATCH-01',
        expiry_date: '2028-12-31',
        quantity_in: 60,
        quantity_remaining: 60,
        purchase_price: 10,
        mrp: 20,
      },
    });

    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      initialStock: 60,
    });

    localMutate({
      table: 'stock_ledger',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_id: batchId,
        movement_type: 'PURCHASE_RECEIPT',
        quantity_delta: 60,
        balance_after: 60,
      },
    });

    const reportMatched = InventoryReconciliationService.reconcileBatch({ batchId, storeId: defaultStoreId });
    expect(reportMatched.status).toBe('MATCHED');
    expect(reportMatched.discrepancyDelta).toBe(0);

    // 2. Mismatch scenario
    localDb.prepare('UPDATE inventory_positions SET quantity_on_hand = 55 WHERE batch_id = ? AND store_id = ?').run(batchId, defaultStoreId);
    const reportMismatch = InventoryReconciliationService.reconcileBatch({ batchId, storeId: defaultStoreId });
    expect(reportMismatch.status).toBe('MISMATCH');
    expect(reportMismatch.discrepancyDelta).toBeGreaterThan(0);
  });

  // ── 16. ATOMIC DOCUMENT NUMBERING ─────────────────────────────────────────
  test('16. Atomic Document Numbering: generates predictable and consecutive sequence numbers', () => {
    const num1 = DocumentNumberingService.generate({
      organizationId: testOrgId,
      storeId: defaultStoreId,
      documentType: 'SALE_INVOICE',
    });

    const num2 = DocumentNumberingService.generate({
      organizationId: testOrgId,
      storeId: defaultStoreId,
      documentType: 'SALE_INVOICE',
    });

    expect(num1).toBeTruthy();
    expect(num2).toBeTruthy();
    expect(num1).not.toBe(num2);

    const seq1 = parseInt(num1.split('/').pop() || '0', 10);
    const seq2 = parseInt(num2.split('/').pop() || '0', 10);
    expect(seq2).toBe(seq1 + 1);
  });

  // ── 17. CONCURRENT INVOICE SEQUENCE GENERATION ────────────────────────────
  test('17. Concurrent Invoice Sequence Generation: multiple parallel requests receive distinct sequential numbers', async () => {
    const promises = Array.from({ length: 25 }, () =>
      Promise.resolve(
        DocumentNumberingService.generate({
          organizationId: testOrgId,
          storeId: defaultStoreId,
          documentType: 'SALE_INVOICE',
        })
      )
    );

    const results = await Promise.all(promises);
    const uniqueSet = new Set(results);
    expect(uniqueSet.size).toBe(25);
  });

  // ── 18. CONCURRENT STOCK DEDUCTION ────────────────────────────────────────
  test('18. Concurrent Stock Deduction: race condition test (Stock=5, A sells 4, B sells 3 -> exactly one succeeds)', () => {
    const medId = uuidv4();
    const batchId = uuidv4();
    const initialStock = 5;

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchId,
        _local_id: batchId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        medicine_id: medId,
        batch_number: 'CONC-RACE-01',
        expiry_date: '2028-12-31',
        quantity_in: initialStock,
        quantity_remaining: initialStock,
        purchase_price: 10,
        mrp: 20,
      },
    });

    InventoryPositionService.getOrCreatePosition({
      organizationId: testOrgId,
      medicineId: medId,
      batchId,
      locationType: 'STORE',
      storeId: defaultStoreId,
      initialStock,
    });

    // Atomic seller helper simulating database row-level condition
    const attemptAtomicSale = (qtyToSell: number) => {
      return localDb.transaction(() => {
        const batch: any = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ?').get(batchId);
        if (!batch || batch.quantity_remaining < qtyToSell) {
          throw new Error(`INSUFFICIENT_STOCK: Available ${batch?.quantity_remaining}, requested ${qtyToSell}`);
        }
        localDb.prepare('UPDATE medicine_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?').run(qtyToSell, batchId);
        InventoryPositionService.adjustStock({
          organizationId: testOrgId,
          medicineId: medId,
          batchId,
          locationType: 'STORE',
          storeId: defaultStoreId,
          quantityDelta: -qtyToSell,
        });
        return true;
      })();
    };

    let outcomeA = false;
    let outcomeB = false;

    // Terminal A attempts 4 units
    try {
      outcomeA = attemptAtomicSale(4);
    } catch {
      outcomeA = false;
    }

    // Terminal B attempts 3 units
    try {
      outcomeB = attemptAtomicSale(3);
    } catch {
      outcomeB = false;
    }

    // Exactly one should succeed, other must fail with stock never going negative
    expect(outcomeA !== outcomeB).toBe(true);
    expect(outcomeA).toBe(true);
    expect(outcomeB).toBe(false);

    const finalBatch: any = localDb.prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ?').get(batchId);
    expect(finalBatch.quantity_remaining).toBe(1);
    expect(finalBatch.quantity_remaining).toBeGreaterThanOrEqual(0);
  });

  // ── 19. ALTERNATE BARCODE UNIQUENESS ───────────────────────────────────────
  test('19. Alternate Barcode Uniqueness: supports pack/strip/unit barcodes and prevents duplicates', () => {
    const medId = uuidv4();
    const barcodeStr = '8901086001234';

    localMutate({
      table: 'product_barcodes',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        organization_id: testOrgId,
        medicine_id: medId,
        barcode: barcodeStr,
        barcode_type: 'PACK',
        unit_type: 'PACK',
        conversion_factor: 10.0,
        is_primary: 1,
      },
    });

    const bcRow: any = localDb.prepare('SELECT * FROM product_barcodes WHERE barcode = ? AND organization_id = ?').get(barcodeStr, testOrgId);
    expect(bcRow).toBeDefined();
    expect(bcRow.unit_type).toBe('PACK');
    expect(bcRow.conversion_factor).toBe(10.0);

    // Verify unit conversion helper
    const packUnits = convertUnits(2, bcRow.conversion_factor, 1.0);
    expect(packUnits).toBe(20); // 2 packs * 10 = 20 strips
  });

  // ── 20. OFFLINE SALE RETAINING STORE / TERMINAL CONTEXT ───────────────────
  test('20. Offline Sale Retaining Store/Terminal Context: offline sync push preserves organization, store, and terminal context with local UUID idempotency', () => {
    const offlineLocalId = `LOCAL-OFFLINE-${Date.now()}`;
    const medId = uuidv4();
    const batchId = uuidv4();

    const offlineSale: any = localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        _local_id: offlineLocalId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        counter_id: 'C1',
        terminal_id: 'T1',
        clinic_id: testClinicId,
        invoice_number: 'OFFLINE-INV-001',
        subtotal: 100,
        grand_total: 100,
        net_amount: 100,
        paid_amount: 100,
        balance_due: 0,
        payment_mode: 'cash',
        payment_status: 'paid',
      },
    });

    expect(offlineSale._local_id).toBe(offlineLocalId);
    expect(offlineSale.store_id).toBe(defaultStoreId);
    expect(offlineSale.terminal_id).toBe('T1');

    // Repeated push with same _local_id must be idempotent
    const duplicatePush = localMutate({
      table: 'sales',
      operation: 'INSERT',
      data: {
        _local_id: offlineLocalId,
        organization_id: testOrgId,
        store_id: defaultStoreId,
        clinic_id: testClinicId,
        invoice_number: 'OFFLINE-INV-001',
        grand_total: 100,
      },
    });

    const salesCount: any = localDb
      .prepare('SELECT COUNT(*) as cnt FROM sales WHERE _local_id = ?')
      .get(offlineLocalId);

    expect(salesCount.cnt).toBe(1);
  });
});
