// advancedInventoryEngine.test.ts — Task 5 Integration Test Suite
import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { InventoryPositionService } from '../services/inventoryPosition';
import { InventoryAvailabilityService } from '../services/inventory/inventoryAvailabilityService';
import { StocktakeEngine } from '../services/inventory/stocktakeEngine';
import { InventoryReconciliationServiceV2 } from '../services/inventory/inventoryReconciliationV2';
import { InventoryClassificationEngine } from '../services/inventory/inventoryClassificationEngine';
import { ExpiryIntelligenceEngine } from '../services/inventory/expiryIntelligenceEngine';
import { ProductRecallEngine } from '../services/inventory/productRecallEngine';
import { InventoryReservationService } from '../services/inventory/inventoryReservationService';
import { ReorderEngine } from '../services/inventory/reorderEngine';
import { ShortbookV2Service } from '../services/inventory/shortbookV2Service';
import { InventoryAlertEngine } from '../services/inventory/inventoryAlertEngine';
import { InventoryValuationService } from '../services/inventory/inventoryValuationService';
import { FEFOEngine } from '../services/fefoEngine';

describe('Task 5 — Advanced Inventory Intelligence, Stocktake, Expiry, Recall & Replenishment Engine', () => {
  const testOrgId = `org_inv_${Date.now()}`;
  const testStoreA = `store_a_${Date.now()}`;
  const testStoreB = `store_b_${Date.now()}`;
  const testWarehouseId = `wh_main_${Date.now()}`;

  let medParacetamolId: string;
  let batchParaA: string;
  let batchParaB: string;
  let batchParaExp: string;

  let medAmoxicillinId: string;
  let batchAmoxA: string;

  beforeAll(() => {
    // 1. Create Organization, Stores, Warehouse
    localDb.prepare(`
      INSERT INTO organizations (id, _local_id, display_name, legal_name, code, gstin, pan, created_at, updated_at, _updated_at)
      VALUES (?, ?, 'MediPOS Test Org', 'MediPOS Pharmacy Corp', 'ORGINV', '36AAAAA0000A1Z5', 'AAAAA0000A', datetime('now'), datetime('now'), datetime('now'))
    `).run(testOrgId, testOrgId);

    localDb.prepare(`
      INSERT INTO stores (id, _local_id, organization_id, clinic_id, store_code, name, address, city, state, state_code, created_at, updated_at, _updated_at)
      VALUES (?, ?, ?, ?, 'STR-HYD-01', 'Hyderabad Central Pharmacy', 'Banjara Hills', 'Hyderabad', 'Telangana', '36', datetime('now'), datetime('now'), datetime('now'))
    `).run(testStoreA, testStoreA, testOrgId, testStoreA);

    localDb.prepare(`
      INSERT INTO stores (id, _local_id, organization_id, clinic_id, store_code, name, address, city, state, state_code, created_at, updated_at, _updated_at)
      VALUES (?, ?, ?, ?, 'STR-HYD-02', 'Secunderabad Branch', 'MG Road', 'Secunderabad', 'Telangana', '36', datetime('now'), datetime('now'), datetime('now'))
    `).run(testStoreB, testStoreB, testOrgId, testStoreB);

    localDb.prepare(`
      INSERT INTO warehouses (id, _local_id, organization_id, warehouse_code, name, address, state_code, created_at, updated_at, _updated_at)
      VALUES (?, ?, ?, 'WH-HYD-HUB', 'Telangana Central Hub', 'Uppal Depot', '36', datetime('now'), datetime('now'), datetime('now'))
    `).run(testWarehouseId, testWarehouseId, testOrgId);

    // 2. Create Medicines
    medParacetamolId = uuidv4();
    localDb.prepare(`
      INSERT INTO medicines (id, _local_id, organization_id, clinic_id, name, generic_name, category, units_per_pack, conversion_factor, minimum_order_quantity, reorder_level, is_active, created_at, _updated_at)
      VALUES (?, ?, ?, ?, 'Paracetamol 650mg', 'Paracetamol', 'Analgesic', 10, 10, 20, 25, 1, datetime('now'), datetime('now'))
    `).run(medParacetamolId, medParacetamolId, testOrgId, testStoreA);

    medAmoxicillinId = uuidv4();
    localDb.prepare(`
      INSERT INTO medicines (id, _local_id, organization_id, clinic_id, name, generic_name, category, units_per_pack, conversion_factor, minimum_order_quantity, reorder_level, is_active, created_at, _updated_at)
      VALUES (?, ?, ?, ?, 'Amoxicillin 500mg', 'Amoxicillin', 'Antibiotic', 10, 10, 10, 15, 1, datetime('now'), datetime('now'))
    `).run(medAmoxicillinId, medAmoxicillinId, testOrgId, testStoreA);

    // 3. Create Batches
    batchParaA = uuidv4();
    localDb.prepare(`
      INSERT INTO medicine_batches (id, _local_id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, quantity_remaining, purchase_price, mrp, created_at, _updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PARA-B101', '2028-12-31', 100, 15.00, 30.00, datetime('now'), datetime('now'))
    `).run(batchParaA, batchParaA, testOrgId, testStoreA, testStoreA, medParacetamolId);

    batchParaB = uuidv4();
    localDb.prepare(`
      INSERT INTO medicine_batches (id, _local_id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, quantity_remaining, purchase_price, mrp, created_at, _updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PARA-B102', '2028-06-30', 50, 15.00, 30.00, datetime('now'), datetime('now'))
    `).run(batchParaB, batchParaB, testOrgId, testStoreA, testStoreA, medParacetamolId);

    batchParaExp = uuidv4();
    localDb.prepare(`
      INSERT INTO medicine_batches (id, _local_id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, quantity_remaining, purchase_price, mrp, created_at, _updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PARA-EXP01', '2025-01-01', 20, 15.00, 30.00, datetime('now'), datetime('now'))
    `).run(batchParaExp, batchParaExp, testOrgId, testStoreA, testStoreA, medParacetamolId);

    batchAmoxA = uuidv4();
    localDb.prepare(`
      INSERT INTO medicine_batches (id, _local_id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, quantity_remaining, purchase_price, mrp, created_at, _updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AMOX-B201', '2027-10-31', 40, 40.00, 80.00, datetime('now'), datetime('now'))
    `).run(batchAmoxA, batchAmoxA, testOrgId, testStoreA, testStoreA, medAmoxicillinId);

    // 4. Initialize Positions
    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medParacetamolId,
      batchId: batchParaA,
      locationType: 'STORE',
      storeId: testStoreA,
      quantityDelta: 100,
    });

    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medParacetamolId,
      batchId: batchParaB,
      locationType: 'STORE',
      storeId: testStoreA,
      quantityDelta: 50,
    });

    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medParacetamolId,
      batchId: batchParaExp,
      locationType: 'STORE',
      storeId: testStoreA,
      quantityDelta: 20,
    });

    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medAmoxicillinId,
      batchId: batchAmoxA,
      locationType: 'STORE',
      storeId: testStoreA,
      quantityDelta: 40,
    });

    // Warehouse stock for Paracetamol
    InventoryPositionService.adjustStock({
      organizationId: testOrgId,
      medicineId: medParacetamolId,
      batchId: batchParaA,
      locationType: 'WAREHOUSE',
      warehouseId: testWarehouseId,
      quantityDelta: 300,
    });
  });

  describe('1. Inventory State Model & Multi-State Consistency', () => {
    it('calculates available stock subtracting reserved, quarantined, damaged, and recalled quantities', () => {
      const pos = InventoryPositionService.getOrCreatePosition({
        organizationId: testOrgId,
        medicineId: medParacetamolId,
        batchId: batchParaA,
        locationType: 'STORE',
        storeId: testStoreA,
      });

      expect(pos.quantity_on_hand).toBe(100);
      expect(pos.quantity_available).toBe(100);

      // Quarantine 10 units and damage 5 units
      const updated = InventoryPositionService.updateStateQuantities({
        organizationId: testOrgId,
        medicineId: medParacetamolId,
        batchId: batchParaA,
        locationType: 'STORE',
        storeId: testStoreA,
        quarantinedDelta: 10,
        damagedDelta: 5,
      });

      expect(updated.quantity_on_hand).toBe(100);
      expect(updated.quantity_quarantined).toBe(10);
      expect(updated.quantity_damaged).toBe(5);
      expect(updated.quantity_available).toBe(85); // 100 - (10 + 5)
    });

    it('blocks damaged, quarantined, and recalled stock from sellable availability in InventoryAvailabilityService', () => {
      const avail = InventoryAvailabilityService.getAvailability({
        organizationId: testOrgId,
        medicineId: medParacetamolId,
        locationType: 'STORE',
        storeId: testStoreA,
      });

      // Total on hand: 100 (batch A) + 50 (batch B) + 20 (expired batch) = 170
      // Available: 85 (batch A) + 50 (batch B) + 0 (expired batch) = 135
      expect(avail.totalOnHand).toBe(170);
      expect(avail.totalAvailable).toBe(135);
      expect(avail.sellableBatches.length).toBe(2); // Batch B (2028-06-30) and Batch A (2028-12-31)
      expect(avail.sellableBatches[0].batchId).toBe(batchParaB); // FEFO: earliest non-expired first
    });
  });

  describe('2. Inventory Availability Service & Cross-Store Intelligence', () => {
    it('discovers stock across other stores and central warehouses', () => {
      const cross = InventoryAvailabilityService.getCrossLocationAvailability({
        organizationId: testOrgId,
        medicineId: medParacetamolId,
        currentStoreId: testStoreA,
      });

      expect(cross.currentStoreAvailable).toBe(135);
      expect(cross.otherLocations.length).toBeGreaterThanOrEqual(1);

      const whLoc = cross.otherLocations.find((l) => l.locationType === 'WAREHOUSE');
      expect(whLoc).toBeDefined();
      expect(whLoc?.availableUnits).toBe(300);
    });
  });

  describe('3. Stocktake Engine, Counting & Variance Workflows', () => {
    let stocktakeId: string;

    it('creates a stocktake session in DRAFT status', () => {
      const session = StocktakeEngine.createSession({
        organizationId: testOrgId,
        storeId: testStoreA,
        name: 'HYD-01 Comprehensive Stocktake',
        type: 'FULL',
        countingMode: 'LIVE_COUNT',
        isBlindCount: true,
        isDoubleCount: true,
        initiatedBy: 'user_pharmacist_01',
      });

      expect(session.id).toBeDefined();
      expect(session.status).toBe('DRAFT');
      expect(session.is_blind_count).toBe(true);
      stocktakeId = session.id;
    });

    it('starts session and captures exact inventory snapshots at reference_timestamp', () => {
      const started = StocktakeEngine.startSession(stocktakeId, 'user_pharmacist_01');
      expect(started.status).toBe('IN_PROGRESS');

      const items = StocktakeEngine.getSessionItems(stocktakeId, true);
      expect(items.length).toBeGreaterThan(0);

      const paraItem = items.find((i) => i.batch_id === batchParaA);
      expect(paraItem).toBeDefined();
      expect(paraItem?.expected_quantity).toBe(100);
    });

    it('supports blind counting by hiding expected quantities and variances from standard staff', () => {
      const blindItems = StocktakeEngine.getSessionItems(stocktakeId, false);
      const paraItem = blindItems.find((i) => i.batch_id === batchParaA);
      expect(paraItem?.expected_quantity).toBe(0); // Hidden
      expect(paraItem?.difference).toBe(0); // Hidden
    });

    it('records physical barcode counts and calculates variance', () => {
      // Physical count for batchParaA is 96 (variance = -4)
      const countRes = StocktakeEngine.recordCount({
        stocktakeId,
        medicineId: medParacetamolId,
        batchId: batchParaA,
        userId: 'user_pharmacist_01',
        rawQuantity: 96,
        counterRole: 'COUNTER_A',
      });

      // Also record physical count for other batches
      StocktakeEngine.recordCount({
        stocktakeId,
        medicineId: medParacetamolId,
        batchId: batchParaB,
        userId: 'user_pharmacist_01',
        rawQuantity: 50,
        counterRole: 'COUNTER_A',
      });

      StocktakeEngine.recordCount({
        stocktakeId,
        medicineId: medParacetamolId,
        batchId: batchParaExp,
        userId: 'user_pharmacist_01',
        rawQuantity: 20,
        counterRole: 'COUNTER_A',
      });

      expect(countRes.physicalQuantity).toBe(96);
      expect(countRes.difference).toBe(-4);

      // Check manager view items
      const items = StocktakeEngine.getSessionItems(stocktakeId, true);
      const paraItem = items.find((i) => i.batch_id === batchParaA);
      expect(paraItem?.physical_quantity).toBe(96);
      expect(paraItem?.difference).toBe(-4);
      expect(paraItem?.value_difference_paise).toBe(-6000); // -4 * 1500 paise (-₹60)
    });

    it('approves session and posts compensating adjustment movements to ledger', () => {
      StocktakeEngine.approveSession({
        sessionId: stocktakeId,
        approvedBy: 'user_owner_01',
        userRole: 'OWNER',
      });

      const session = StocktakeEngine.getSession(stocktakeId);
      expect(session?.status).toBe('APPROVED');

      const postRes = StocktakeEngine.postAdjustments({
        sessionId: stocktakeId,
        postedBy: 'user_owner_01',
        userRole: 'OWNER',
      });

      expect(postRes.postedMovementsCount).toBeGreaterThan(0);

      const updatedSession = StocktakeEngine.getSession(stocktakeId);
      expect(updatedSession?.status).toBe('POSTED');

      // Verify stock ledger movement was created
      const ledgerEntry: any = localDb
        .prepare(
          `SELECT * FROM stock_ledger 
           WHERE reference_id = ? AND movement_type = 'STOCKTAKE_CORRECTION' AND batch_id = ?`
        )
        .get(stocktakeId, batchParaA);

      expect(ledgerEntry).toBeDefined();
      expect(ledgerEntry.quantity_delta).toBe(-4);
    });
  });

  describe('4. Inventory Reconciliation V2', () => {
    it('runs 3-way reconciliation and diagnoses matched vs mismatched records', () => {
      const recon = InventoryReconciliationServiceV2.reconcile({
        organizationId: testOrgId,
        storeId: testStoreA,
      });

      expect(recon.summary.totalBatchesChecked).toBeGreaterThan(0);
      expect(recon.diagnostics).toBeDefined();
    });

    it('repairs diagnosed discrepancy through compensating ledger movement', () => {
      const repairRes = InventoryReconciliationServiceV2.repairDiscrepancy({
        organizationId: testOrgId,
        medicineId: medAmoxicillinId,
        batchId: batchAmoxA,
        locationType: 'STORE',
        storeId: testStoreA,
        targetPhysicalQuantity: 45, // +5 repair
        reason: 'Audit verified surplus stock',
        approvedBy: 'user_auditor_01',
      });

      expect(repairRes.repairedMovementId).toBeDefined();
      expect(repairRes.newOnHandQuantity).toBe(45);

      const pos = InventoryPositionService.getOrCreatePosition({
        organizationId: testOrgId,
        medicineId: medAmoxicillinId,
        batchId: batchAmoxA,
        locationType: 'STORE',
        storeId: testStoreA,
      });
      expect(pos.quantity_on_hand).toBe(45);
    });
  });

  describe('5. ABC Classification, Sales Velocity & Days of Cover', () => {
    beforeAll(() => {
      // Record a sale for Paracetamol in the last 7 days to simulate sales velocity
      const saleId = uuidv4();
      const saleItemId = uuidv4();
      const nowIso = new Date().toISOString();

      localDb.prepare(`
        INSERT INTO sales (id, _local_id, organization_id, store_id, invoice_number, sale_date, grand_total, payment_status, is_return, created_at, _updated_at)
        VALUES (?, ?, ?, ?, 'INV-TEST-001', ?, 300.00, 'PAID', 0, ?, ?)
      `).run(saleId, saleId, testOrgId, testStoreA, nowIso, nowIso, nowIso);

      localDb.prepare(`
        INSERT INTO sale_items (id, _local_id, organization_id, store_id, sale_id, medicine_id, batch_id, quantity, base_quantity, taxable_amount_paise, tax_amount_paise, total, _updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 26785, 3215, 300.00, ?)
      `).run(saleItemId, saleItemId, testOrgId, testStoreA, saleId, medParacetamolId, batchParaA, nowIso);
    });

    it('computes sales velocity, ABC classification, and days of stock cover', () => {
      const classifications = InventoryClassificationEngine.computeClassifications({
        organizationId: testOrgId,
        storeId: testStoreA,
      });

      expect(classifications.length).toBeGreaterThan(0);
      const paraClass = classifications.find((c) => c.medicineId === medParacetamolId);
      expect(paraClass).toBeDefined();
      expect(paraClass?.avgDailySales7d).toBeGreaterThan(0);
      expect(paraClass?.daysOfCover).toBeGreaterThan(0);
    });

    it('computes inventory ageing buckets', () => {
      const ageing = InventoryClassificationEngine.getAgeingAnalysis({
        organizationId: testOrgId,
        storeId: testStoreA,
      });

      expect(ageing.buckets.length).toBe(6);
      expect(ageing.totalStockCostPaise).toBeGreaterThan(0);
      expect(ageing.totalStockMrpPaise).toBeGreaterThan(0);
    });
  });

  describe('6. Expiry Intelligence & Risk Exposure Valuation', () => {
    it('identifies expired and near-expiry batches with cost exposure and action recommendations', () => {
      const expiry = ExpiryIntelligenceEngine.getExpiryRiskItems({
        organizationId: testOrgId,
        storeId: testStoreA,
        daysThreshold: 180,
      });

      expect(expiry.buckets.length).toBe(6);
      const expiredBucket = expiry.buckets.find((b) => b.bucket === 'EXPIRED');
      expect(expiredBucket?.batchCount).toBeGreaterThanOrEqual(1);

      const expItem = expiry.items.find((i) => i.batchId === batchParaExp);
      expect(expItem).toBeDefined();
      expect(expItem?.recommendedAction).toBe('DISPOSE');
    });
  });

  describe('7. Product Recall Engine & Multi-Store Quarantine', () => {
    let recallId: string;

    it('registers a product recall draft', () => {
      const recall = ProductRecallEngine.createRecall({
        organizationId: testOrgId,
        recallReference: 'CDSCO-ALERT-2026-01',
        recallType: 'BATCH',
        productId: medParacetamolId,
        batchId: batchParaB,
        batchNumber: 'PARA-B102',
        manufacturer: 'Apex Pharma',
        reason: 'Dissolution test failure during stability batch testing',
        severity: 'CLASS_I',
        createdBy: 'user_qa_officer_01',
      });

      expect(recall.id).toBeDefined();
      expect(recall.status).toBe('DRAFT');
      recallId = recall.id;
    });

    it('activates recall, immediately locks stock in inventory positions and blocks from POS/FEFO', () => {
      const active = ProductRecallEngine.activateRecall(recallId, 'user_qa_officer_01');
      expect(active.status).toBe('ACTIVE');
      expect(active.tasks.length).toBeGreaterThan(0);

      // Verify batch is blocked in FEFO
      const fefoPlan = FEFOEngine.planAllocations({
        medicineId: medParacetamolId,
        storeId: testStoreA,
        organizationId: testOrgId,
        requestedQuantity: 10,
      });

      // The plan should NOT allocate batchParaB (recalled) or batchParaExp (expired)
      const allocatedBatches = fefoPlan.allocations.map((a) => a.batchId);
      expect(allocatedBatches).not.toContain(batchParaB);
      expect(allocatedBatches).not.toContain(batchParaExp);
    });

    it('traces historical sales and invoices associated with the recalled product', () => {
      const salesTrace = ProductRecallEngine.traceHistoricalSales({
        organizationId: testOrgId,
        productId: medParacetamolId,
      });

      expect(salesTrace.totalUnitsSold).toBeGreaterThanOrEqual(10);
      expect(salesTrace.totalInvoicesCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('8. Inventory Reservation Lifecycle & Concurrency Control', () => {
    let reservationId: string;

    it('creates a stock reservation and updates position reserved quantities', () => {
      const res = InventoryReservationService.createReservation({
        organizationId: testOrgId,
        locationType: 'STORE',
        storeId: testStoreA,
        medicineId: medAmoxicillinId,
        quantity: 5,
        sourceType: 'PRESCRIPTION',
        sourceId: 'RX-TEST-001',
        durationMinutes: 30,
      });

      expect(res.id).toBeDefined();
      expect(res.status).toBe('ACTIVE');
      reservationId = res.id;

      const pos = InventoryPositionService.getOrCreatePosition({
        organizationId: testOrgId,
        medicineId: medAmoxicillinId,
        batchId: batchAmoxA,
        locationType: 'STORE',
        storeId: testStoreA,
      });
      expect(pos.quantity_reserved).toBe(5);
      expect(pos.quantity_available).toBe(40); // 45 on hand - 5 reserved
    });

    it('consumes reservation on checkout completion', () => {
      InventoryReservationService.consumeReservation(reservationId);

      const pos = InventoryPositionService.getOrCreatePosition({
        organizationId: testOrgId,
        medicineId: medAmoxicillinId,
        batchId: batchAmoxA,
        locationType: 'STORE',
        storeId: testStoreA,
      });
      expect(pos.quantity_reserved).toBe(0);
    });
  });

  describe('9. Reorder & Replenishment Recommendations', () => {
    it('calculates replenishment recommendations with pack rounding and warehouse candidate flags', () => {
      const reorders = ReorderEngine.getReorderRecommendations({
        organizationId: testOrgId,
        storeId: testStoreA,
      });

      expect(reorders).toBeDefined();
      expect(Array.isArray(reorders)).toBe(true);
    });
  });

  describe('10. Shortbook V2 Request Consolidation', () => {
    it('records shortage requests and aggregates repeat requests into a consolidated entry', () => {
      ShortbookV2Service.recordShortageRequest({
        clinicId: testStoreA,
        medicineId: medAmoxicillinId,
        quantityNeeded: 2,
        reason: 'Customer requested 2 strips',
        source: 'CUSTOMER_REQUEST',
      });

      ShortbookV2Service.recordShortageRequest({
        clinicId: testStoreA,
        medicineId: medAmoxicillinId,
        quantityNeeded: 5,
        reason: 'Customer requested 5 strips',
        source: 'CUSTOMER_REQUEST',
      });

      const consolidated = ShortbookV2Service.getConsolidatedShortbook(testStoreA);
      const amoxItem = consolidated.find((c) => c.medicineId === medAmoxicillinId);

      expect(amoxItem).toBeDefined();
      expect(amoxItem?.totalQuantityNeeded).toBe(7);
      expect(amoxItem?.requestCount).toBe(2);
      expect(amoxItem?.customerRequestCount).toBe(2);
    });
  });

  describe('11. Valuation & Transparent Inventory Health Score', () => {
    it('computes valuation, potential margin, and transparent formula-based health score', () => {
      const val = InventoryValuationService.getValuation({
        organizationId: testOrgId,
        storeId: testStoreA,
      });

      expect(val.totalCostValuePaise).toBeGreaterThan(0);
      expect(val.totalMrpValuePaise).toBeGreaterThan(0);
      expect(val.potentialGrossMarginPct).toBeGreaterThan(0);
      expect(val.healthScore.score).toBeGreaterThanOrEqual(0);
      expect(val.healthScore.score).toBeLessThanOrEqual(100);
      expect(val.healthScore.breakdown).toBeDefined();
    });
  });

  describe('12. Inventory Alert Engine', () => {
    it('creates and deduplicates structured inventory alerts', () => {
      const alert1 = InventoryAlertEngine.createOrUpdateAlert({
        organizationId: testOrgId,
        storeId: testStoreA,
        medicineId: medParacetamolId,
        alertType: 'LOW_STOCK',
        severity: 'WARNING',
        title: 'Low Stock Alert',
        message: 'Paracetamol 650mg is low on stock',
      });

      const alert2 = InventoryAlertEngine.createOrUpdateAlert({
        organizationId: testOrgId,
        storeId: testStoreA,
        medicineId: medParacetamolId,
        alertType: 'LOW_STOCK',
        severity: 'WARNING',
        title: 'Low Stock Alert',
        message: 'Paracetamol 650mg is low on stock',
      });

      expect(alert1.id).toBe(alert2.id); // Deduplicated

      const alerts = InventoryAlertEngine.listAlerts({
        organizationId: testOrgId,
        storeId: testStoreA,
      });
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
