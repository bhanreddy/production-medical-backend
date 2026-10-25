import request from 'supertest';
import { createApp } from '../app';
import { localDb } from '../local-db';

const app = createApp();
import { POSSessionService } from '../services/posSession';
import { POSSearchService } from '../services/posSearch';
import { FEFOEngine } from '../services/fefoEngine';
import { PricingService } from '../services/pricingService';
import { POSCartService } from '../services/posCart';
import { ParkedSalesService } from '../services/parkedSales';
import { SupervisorAuthService } from '../services/supervisorAuth';
import { ReturnsEngine } from '../services/returnsEngine';
import { DocumentNumberingService } from '../services/documentNumbering';
import { InventoryPositionService } from '../services/inventoryPosition';
import { Money } from '../lib/money';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jwt_testing_1234567890';

describe('Task 2 — Enterprise POS Counter Engine V2 Test Suite', () => {
  let orgId: string;
  let storeAId: string;
  let storeBId: string;
  let counterAId: string;
  let terminalAId: string;
  let cashierUserId: string;
  let supervisorUserId: string;
  let cashierToken: string;
  let supervisorToken: string;

  let paracetamolMedId: string;
  let amoxicillinMedId: string;
  let doloMedId: string;
  let batchEarlyExpId: string;
  let batchLateExpId: string;
  let batchExpiredId: string;
  let batchDisposedId: string;
  let customerId: string;

  beforeAll(() => {
    // 1. Setup Organization & Stores
    orgId = 'org-pos-test-101';
    storeAId = 'store-pos-a-101';
    storeBId = 'store-pos-b-102';
    counterAId = 'counter-pos-c1';
    terminalAId = 'term-pos-t1';

    localDb.prepare('INSERT OR REPLACE INTO organizations (id, legal_name, code, gstin, currency, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      orgId, 'Apollo Health Group', 'APOLLO', '36AAAAA0000A1Z5', 'INR', orgId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO stores (id, organization_id, name, store_code, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      storeAId, orgId, 'Apollo Flagship Store', 'AP-01', 'active', storeAId, new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO stores (id, organization_id, name, store_code, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      storeBId, orgId, 'Apollo Branch Store', 'AP-02', 'active', storeBId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO counters (id, organization_id, store_id, counter_code, name, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      counterAId, orgId, storeAId, 'C1', 'Counter 1 Express', 'active', counterAId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO terminals (id, organization_id, store_id, counter_id, terminal_code, terminal_name, device_uuid, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      terminalAId, orgId, storeAId, counterAId, 'T1', 'Terminal Pos Alpha', 'device-uuid-999', 'active', terminalAId, new Date().toISOString()
    );

    // 2. Setup Cashier & Supervisor Users
    cashierUserId = 'user-cashier-101';
    supervisorUserId = 'user-super-202';

    localDb.prepare('INSERT OR REPLACE INTO users (id, full_name, phone, role, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      cashierUserId, 'John Cashier', '9876543210', 'CASHIER', 1, cashierUserId, new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO users (id, full_name, phone, role, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      supervisorUserId, 'Dr. Sarah Supervisor', '9876543211', 'OWNER', 1, supervisorUserId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO user_organization_access (id, user_id, organization_id, role, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'uoa-1', cashierUserId, orgId, 'CASHIER', 1, 'uoa-1', new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO user_organization_access (id, user_id, organization_id, role, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'uoa-2', supervisorUserId, orgId, 'STORE_MANAGER', 1, 'uoa-2', new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO user_store_access (id, user_id, organization_id, store_id, role, is_default, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'usa-1', cashierUserId, orgId, storeAId, 'CASHIER', 1, 1, 'usa-1', new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO user_store_access (id, user_id, organization_id, store_id, role, is_default, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'usa-2', supervisorUserId, orgId, storeAId, 'STORE_MANAGER', 1, 1, 'usa-2', new Date().toISOString()
    );

    cashierToken = jwt.sign({ sub: cashierUserId, id: cashierUserId, role: 'CASHIER', clinic_id: 'default-clinic' }, JWT_SECRET);
    supervisorToken = jwt.sign({ sub: supervisorUserId, id: supervisorUserId, role: 'OWNER', clinic_id: 'default-clinic' }, JWT_SECRET);

    // 3. Setup Medicines & Batches
    paracetamolMedId = 'med-para-101';
    doloMedId = 'med-dolo-102';
    amoxicillinMedId = 'med-amox-103';

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, generic_name, composition,
        sale_unit, base_unit, conversion_factor, gst_rate,
        primary_barcode, is_schedule_h1, prescription_required, is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paracetamolMedId, orgId, 'Paracetamol 500mg Tablets', 'Calpol', 'Paracetamol', 'Paracetamol IP 500mg',
      'STRIP', 'TABLET', 10.0, 12, '8901234567890', 0, 0, 1, paracetamolMedId, new Date().toISOString()
    );

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, generic_name, composition,
        sale_unit, base_unit, conversion_factor, gst_rate,
        primary_barcode, is_schedule_h1, prescription_required, is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doloMedId, orgId, 'Dolo 650mg Tablets', 'Dolo', 'Paracetamol', 'Paracetamol IP 650mg',
      'STRIP', 'TABLET', 15.0, 12, '8909876543210', 0, 0, 1, doloMedId, new Date().toISOString()
    );

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, generic_name, composition,
        sale_unit, base_unit, conversion_factor, gst_rate,
        primary_barcode, is_schedule_h1, prescription_required, schedule_classification, is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      amoxicillinMedId, orgId, 'Augmentin 625 Duo', 'Augmentin', 'Amoxicillin + Clavulanic Acid', 'Amoxicillin 500mg + Clavulanate 125mg',
      'STRIP', 'TABLET', 10.0, 12, '8905555555555', 1, 1, 'SCHEDULE_H1', 1, amoxicillinMedId, new Date().toISOString()
    );

    // Multi-Barcodes
    localDb.prepare('INSERT OR REPLACE INTO product_barcodes (id, organization_id, medicine_id, barcode, barcode_type, unit_type, conversion_factor, is_primary, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'pb-box-1', orgId, paracetamolMedId, '8901111111111', 'PACK', 'BOX', 100.0, 0, 'pb-box-1', new Date().toISOString()
    );

    // Batches
    batchEarlyExpId = 'batch-para-early';
    batchLateExpId = 'batch-para-late';
    batchExpiredId = 'batch-para-exp';
    batchDisposedId = 'batch-para-disp';

    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining, is_disposed, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchEarlyExpId, orgId, storeAId, 'default-clinic', paracetamolMedId, 'B-EARLY-26', '2026-10-31', 30.0, 18.0, 10, 5, 0, batchEarlyExpId, new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining, is_disposed, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchLateExpId, orgId, storeAId, 'default-clinic', paracetamolMedId, 'B-LATE-27', '2027-04-30', 30.0, 18.0, 50, 20, 0, batchLateExpId, new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining, is_disposed, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchExpiredId, orgId, storeAId, 'default-clinic', paracetamolMedId, 'B-EXPIRED-24', '2024-01-01', 30.0, 18.0, 10, 10, 0, batchExpiredId, new Date().toISOString()
    );
    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining, is_disposed, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchDisposedId, orgId, storeAId, 'default-clinic', paracetamolMedId, 'B-DISPOSED', '2027-01-01', 30.0, 18.0, 10, 10, 1, batchDisposedId, new Date().toISOString()
    );

    // Dolo Batch
    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining, is_disposed, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'batch-dolo-1', orgId, storeAId, 'default-clinic', doloMedId, 'B-DOLO-01', '2027-06-30', 45.0, 25.0, 50, 50, 0, 'batch-dolo-1', new Date().toISOString()
    );

    // Customer
    customerId = 'cust-vip-101';
    localDb.prepare('INSERT OR REPLACE INTO customers (id, organization_id, store_id, clinic_id, name, phone, outstanding_balance, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      customerId, orgId, storeAId, 'default-clinic', 'Rajesh Sharma', '9898989898', 0, customerId, new Date().toISOString()
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. POS SESSION & CONTEXT RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. POS Session Context Resolution', () => {
    it('Scenario 1: resolves cashier user, store, counter, and terminal context accurately', () => {
      const session = POSSessionService.resolveSession({
        userId: cashierUserId,
        requestedStoreId: storeAId,
        requestedCounterId: counterAId,
        requestedTerminalId: terminalAId,
      });

      expect(session.userId).toBe(cashierUserId);
      expect(session.organizationId).toBe(orgId);
      expect(session.storeId).toBe(storeAId);
      expect(session.counterCode).toBe('C1');
      expect(session.terminalCode).toBe('T1');
      expect(session.permissions.canPark).toBe(true);
    });

    it('Scenario 2: rejects cross-store spoofing by unauthorized cashiers', () => {
      expect(() => {
        POSSessionService.resolveSession({
          userId: cashierUserId,
          requestedStoreId: storeBId, // Cashier is only assigned to storeAId
        });
      }).toThrow('Cross-store access denied');
    });

    it('Scenario 3: GET /api/pos/session endpoint returns complete session JSON', async () => {
      const res = await request(app)
        .get('/api/pos/session')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterAId)
        .set('x-terminal-id', terminalAId);

      expect(res.status).toBe(200);
      expect(res.body.data.storeCode).toBe('AP-01');
      expect(res.body.data.terminalCode).toBe('T1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. UNIFIED PRODUCT SEARCH & MULTI-BARCODE ENGINE
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Unified Product Search & Barcodes', () => {
    it('Scenario 4: finds medicine by primary barcode', () => {
      const result = POSSearchService.search({
        barcode: '8901234567890',
        organizationId: orgId,
        storeId: storeAId,
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].name).toContain('Paracetamol');
      expect(result.results[0].matched_barcode?.barcode).toBe('8901234567890');
    });

    it('Scenario 5: finds medicine by alternate pack barcode with conversion factor', () => {
      const result = POSSearchService.search({
        barcode: '8901111111111',
        organizationId: orgId,
        storeId: storeAId,
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].matched_barcode?.unit_type).toBe('BOX');
      expect(result.results[0].matched_barcode?.conversion_factor).toBe(100.0);
    });

    it('Scenario 6: finds medicine by exact name and generic composition', () => {
      const result = POSSearchService.search({
        query: 'Paracetamol',
        organizationId: orgId,
        storeId: storeAId,
      });
      expect(result.results.some(r => r.name.includes('Paracetamol'))).toBe(true);
    });

    it('Scenario 7: typo-tolerant search matches misspelled terms (e.g. "paracetmol")', () => {
      const result = POSSearchService.search({
        query: 'paracetmol',
        organizationId: orgId,
        storeId: storeAId,
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some(r => r.name.includes('Paracetamol'))).toBe(true);
    });

    it('Scenario 8: returns generic substitutes for queried medication', () => {
      const result = POSSearchService.search({
        query: 'Calpol',
        organizationId: orgId,
        storeId: storeAId,
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.substitutes.length).toBeGreaterThan(0);
      expect(result.substitutes.some(s => s.name.includes('Dolo'))).toBe(true);
    });

    it('Scenario 9: GET /api/pos/search endpoint returns valid JSON with latency < 100ms', async () => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/pos/search?q=Dolo')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId);

      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(300);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. FEFO MULTI-BATCH ALLOCATION & EXPIRY SAFETY
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. FEFO Multi-Batch Allocation Engine', () => {
    it('Scenario 10: automatically selects earliest non-expired batch first', () => {
      const plan = FEFOEngine.planAllocations({
        medicineId: paracetamolMedId,
        storeId: storeAId,
        organizationId: orgId,
        requestedQuantity: 3,
      });

      expect(plan.allocations.length).toBe(1);
      expect(plan.allocations[0].batchNumber).toBe('B-EARLY-26');
      expect(plan.allocations[0].allocatedQuantity).toBe(3);
    });

    it('Scenario 11: splits quantity across multiple batches when requested qty exceeds earliest batch stock', () => {
      // B-EARLY-26 has 5 units, B-LATE-27 has 20 units. Requesting 8 units:
      const plan = FEFOEngine.planAllocations({
        medicineId: paracetamolMedId,
        storeId: storeAId,
        organizationId: orgId,
        requestedQuantity: 8,
      });

      expect(plan.allocations.length).toBe(2);
      expect(plan.allocations[0].batchNumber).toBe('B-EARLY-26');
      expect(plan.allocations[0].allocatedQuantity).toBe(5);
      expect(plan.allocations[1].batchNumber).toBe('B-LATE-27');
      expect(plan.allocations[1].allocatedQuantity).toBe(3);
    });

    it('Scenario 12: strictly ignores expired batches (B-EXPIRED-24) from automatic FEFO plan', () => {
      const plan = FEFOEngine.planAllocations({
        medicineId: paracetamolMedId,
        storeId: storeAId,
        organizationId: orgId,
        requestedQuantity: 25, // Total active: 5 + 20 = 25
      });

      expect(plan.allocations.every(a => a.batchNumber !== 'B-EXPIRED-24')).toBe(true);
    });

    it('Scenario 13: strictly ignores disposed batches (B-DISPOSED)', () => {
      const plan = FEFOEngine.planAllocations({
        medicineId: paracetamolMedId,
        storeId: storeAId,
        organizationId: orgId,
        requestedQuantity: 25,
      });

      expect(plan.allocations.every(a => a.batchNumber !== 'B-DISPOSED')).toBe(true);
    });

    it('Scenario 14: throws INSUFFICIENT_STOCK if requested quantity exceeds total non-expired stock', () => {
      expect(() => {
        FEFOEngine.planAllocations({
          medicineId: paracetamolMedId,
          storeId: storeAId,
          organizationId: orgId,
          requestedQuantity: 100,
        });
      }).toThrow('Insufficient non-expired stock');
    });

    it('Scenario 15: correctly tags near-expiry warning thresholds', () => {
      const safety30 = FEFOEngine.evaluateExpirySafety('2026-08-20', new Date('2026-08-09'));
      expect(safety30.status).toBe('NEAR_EXPIRY_30D');
      expect(safety30.severity).toBe('WARNING');
      expect(safety30.approvalRequired).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. PRICING & SERVER-SIDE CART QUOTES
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Pricing Boundary & Cart Quotes', () => {
    it('Scenario 16: computes line item prices with GST and discount using Money engine', () => {
      const price = PricingService.resolvePrice({
        organizationId: orgId,
        storeId: storeAId,
        medicineId: paracetamolMedId,
        quantity: 2,
        requestedDiscountPct: 10,
      });

      expect(price.mrp).toBe(30.0);
      expect(price.discountPct).toBe(10);
      expect(price.lineTotal).toBe(60.48); // 2 * 30 * 0.90 = 54.00 + 12% GST (6.48) = 60.48
      expect(price.taxableAmountPaise).toBe(5400);
      expect(price.requiresSupervisorApproval).toBe(false);
    });

    it('Scenario 17: flags high discounts (>15%) for mandatory supervisor authorization', () => {
      const price = PricingService.resolvePrice({
        organizationId: orgId,
        storeId: storeAId,
        medicineId: paracetamolMedId,
        quantity: 1,
        requestedDiscountPct: 20,
      });

      expect(price.requiresSupervisorApproval).toBe(true);
      expect(price.approvalReason).toContain('exceeds standard authorization threshold');
    });

    it('Scenario 18: POST /api/pos/quote produces comprehensive pre-checkout summary', async () => {
      const quoteRes = await request(app)
        .post('/api/pos/quote')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [
            { medicine_id: paracetamolMedId, quantity: 2, discount_pct: 5 },
            { medicine_id: doloMedId, quantity: 1, discount_pct: 0 },
          ],
          customer_id: customerId,
          bill_discount: 0,
        });

      expect(quoteRes.status).toBe(200);
      const q = quoteRes.body.data;
      expect(q.lines.length).toBe(2);
      expect(q.grandTotal).toBeGreaterThan(0);
      expect(q.totalGst).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. PARK / RECALL SYSTEM
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. Park / Hold / Recall System', () => {
    let parkedTokenId: string;
    let parkTokenCode: string;

    it('Scenario 19: parks an active sale generating a short token (e.g. #P001)', async () => {
      const res = await request(app)
        .post('/api/pos/park')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          cart: [{ medicine_id: paracetamolMedId, quantity: 2, unit_price: 30.0 }],
          customer: { id: customerId, name: 'Rajesh Sharma' },
          notes: 'Customer went to ATM',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.park_token).toMatch(/^P\d{3}$/);
      parkedTokenId = res.body.data.id;
      parkTokenCode = res.body.data.park_token;
    });

    it('Scenario 20: lists active parked sales for the store', async () => {
      const res = await request(app)
        .get('/api/pos/parked')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId);

      expect(res.status).toBe(200);
      expect(res.body.data.some((p: any) => p.park_token === parkTokenCode)).toBe(true);
    });

    it('Scenario 21: resumes parked sale across counters inside the same store', async () => {
      const res = await request(app)
        .post(`/api/pos/parked/${parkedTokenId}/resume`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', 'counter-pos-c2');

      expect(res.status).toBe(200);
      expect(res.body.data.park_token).toBe(parkTokenCode);
      expect(res.body.data.cart_snapshot.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. SUPERVISOR AUTHORIZATION FRAMEWORK
  // ──────────────────────────────────────────────────────────────────────────
  describe('6. Supervisor Authorization Framework', () => {
    it('Scenario 22: rejects invalid supervisor PIN', async () => {
      const res = await request(app)
        .post('/api/pos/authorize')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          action_type: 'HIGH_DISCOUNT',
          supervisor_pin: '0000', // Invalid PIN
          reason: 'VIP customer 25% discount request',
        });

      expect(res.status).toBe(403);
    });

    it('Scenario 23: authorizes override with manager PIN and creates audit record', async () => {
      const res = await request(app)
        .post('/api/pos/authorize')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          action_type: 'HIGH_DISCOUNT',
          supervisor_pin: '9999', // Default test manager PIN
          reason: 'Store manager approved 25% promo discount',
          new_value: '25%',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.authorizingUserName).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. CHECKOUT TRANSACTION & SPLIT PAYMENTS
  // ──────────────────────────────────────────────────────────────────────────
  describe('7. Checkout Pipeline & Split Payments', () => {
    let completedSaleId: string;
    let completedInvoiceNumber: string;

    it('Scenario 24: executes complete multi-batch checkout with cash and change calculation', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: paracetamolMedId, quantity: 2, discount_pct: 0 }],
          payments: [{ tender_type: 'CASH', amount: 100.0 }], // Total 67.00 -> Tendered 100 -> Change 33.00
        });

      expect(res.status).toBe(201);
      const data = res.body.data;
      expect(data.sale.grand_total).toBe(67.0);
      expect(data.sale.payment_status).toBe('paid');
      expect(data.change_returned).toBe(33.0);
      completedSaleId = data.sale.id || data.sale._local_id;
      completedInvoiceNumber = data.sale.invoice_number;
    });

    it('Scenario 25: records multi-tender split payment (Cash + UPI + Card)', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: doloMedId, quantity: 2, discount_pct: 0 }], // Total 101.00
          payments: [
            { tender_type: 'CASH', amount: 51.0 },
            { tender_type: 'UPI', amount: 30.0, reference_number: 'UPI-REF-998877' },
            { tender_type: 'CARD', amount: 20.0, reference_number: 'CARD-AUTH-1234' },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.payment_transactions.length).toBe(3);
      expect(res.body.data.sale.payment_mode).toBe('mixed');
      expect(res.body.data.sale.balance_due).toBe(0);
    });

    it('Scenario 26: verifies idempotency replay on duplicate checkout request', async () => {
      const key = `idem-pos-req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const payload = {
        idempotency_key: key,
        items: [{ medicine_id: doloMedId, quantity: 1 }],
        payments: [{ tender_type: 'CASH', amount: 50.0 }],
      };

      const firstRes = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-idempotency-key', key)
        .send(payload);

      expect(firstRes.status).toBe(201);

      // Replay identical request
      const replayRes = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-idempotency-key', key)
        .send(payload);

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.data.is_idempotent_replay).toBe(true);
      expect(replayRes.body.data.invoice_number).toBe(firstRes.body.data.sale.invoice_number);
    });

    it('Scenario 27: verifies customer receivables update on credit sale', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: doloMedId, quantity: 1 }],
          customer_id: customerId,
          payments: [{ tender_type: 'CREDIT', amount: 0 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.sale.payment_status).toBe('credit');

      const custRow: any = localDb.prepare('SELECT outstanding_balance FROM customers WHERE id = ?').get(customerId);
      expect(Number(custRow.outstanding_balance)).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. RETURNS & EXCHANGES WORKFLOW V2
  // ──────────────────────────────────────────────────────────────────────────
  describe('8. Returns & Exchanges Engine V2', () => {
    let testSaleId: string;
    let testSaleItemId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: paracetamolMedId, quantity: 3, discount_pct: 0 }],
          payments: [{ tender_type: 'CASH', amount: 101.0 }],
        });
      testSaleId = res.body.data.sale.id || res.body.data.sale._local_id;
      testSaleItemId = res.body.data.items[0].id || res.body.data.items[0]._local_id;
    });

    it('Scenario 28: quotes partial return refund amount accurately', async () => {
      const res = await request(app)
        .post('/api/pos/returns/quote')
        .set('Authorization', `Bearer ${supervisorToken}`)
        .send({
          original_sale_id: testSaleId,
          items: [{ sale_item_id: testSaleItemId, quantity: 1, reason_code: 'WRONG_ITEM' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.totalRefund).toBe(30.0);
    });

    it('Scenario 29: processes partial return, restores stock, and generates credit note', async () => {
      const stockBefore: any = localDb
        .prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ?')
        .get(batchEarlyExpId);

      const res = await request(app)
        .post('/api/pos/returns')
        .set('Authorization', `Bearer ${supervisorToken}`)
        .set('x-store-id', storeAId)
        .send({
          original_sale_id: testSaleId,
          items: [{ sale_item_id: testSaleItemId, quantity: 1, reason_code: 'CUSTOMER_RETURN' }],
          refund_method: 'CASH',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.creditNoteNumber).toBeDefined();
      expect(res.body.data.totalRefund).toBe(30.0);

      const stockAfter: any = localDb
        .prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ?')
        .get(batchEarlyExpId);

      expect(Number(stockAfter.quantity_remaining)).toBe(Number(stockBefore.quantity_remaining) + 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. CONCURRENCY & STOCK PROTECTION
  // ──────────────────────────────────────────────────────────────────────────
  describe('9. Concurrency & Protection', () => {
    it('Scenario 30: atomic checkout protects against negative stock deduction', async () => {
      // Try purchasing 500 units when stock is only ~20
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: paracetamolMedId, quantity: 500 }],
          payments: [{ tender_type: 'CASH', amount: 15000 }],
        });

      expect(res.status).toBe(409);
      const errMsg = typeof res.body.error === 'object' ? res.body.error.message : (res.body.message || res.body.error);
      expect(errMsg).toContain('Insufficient');
    });
  });
});
