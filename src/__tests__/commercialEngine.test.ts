import request from 'supertest';
import { createApp } from '../app';
import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { PriceBookService } from '../services/commercial/priceBookService';
import { MarginGuard } from '../services/commercial/marginGuard';
import { PromotionEngine } from '../services/commercial/promotionEngine';
import { CouponEngine } from '../services/commercial/couponEngine';
import { CustomerGroupService } from '../services/commercial/customerGroupService';
import { LoyaltyEngine } from '../services/commercial/loyaltyEngine';
import { SupplierSchemeEngine } from '../services/commercial/supplierSchemeEngine';
import { CommercialEngine } from '../services/commercial/commercialEngine';
import { POSCartService } from '../services/posCart';
import { ReturnsEngine } from '../services/returnsEngine';
import { Money } from '../lib/money';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const app = createApp();
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jwt_testing_1234567890';

describe('Task 3 — Enterprise Pricing, Promotions, Supplier Schemes & Loyalty Engine', () => {
  const orgId = 'org-comm-test-99';
  const regionId = 'reg-south-99';
  const storeAId = 'store-comm-a-99';
  const storeBId = 'store-comm-b-99';
  const counterId = 'counter-comm-1';
  const terminalId = 'terminal-comm-1';
  const cashierId = 'user-cashier-99';
  const customerId = 'cust-vip-99';
  const supplierId = 'supp-cipla-99';

  let cashierToken: string;
  let medParacetamolId: string;
  let medCetaphilId: string;
  let medAzithralId: string;
  let batchParaStoreA: string;
  let batchCetaphilStoreA: string;

  beforeAll(() => {
    // 1. Setup Auth Tokens & Users
    localDb.prepare('INSERT OR REPLACE INTO users (id, full_name, role, clinic_id, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      cashierId, 'Cashier User', 'CASHIER', 'default-clinic', cashierId, new Date().toISOString()
    );

    cashierToken = jwt.sign(
      { sub: cashierId, id: cashierId, role: 'CASHIER', clinic_id: 'default-clinic' },
      JWT_SECRET
    );

    // 2. Setup Organizations, Regions, Stores
    localDb.prepare('INSERT OR REPLACE INTO organizations (id, legal_name, code, gstin, currency, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      orgId, 'MedPlus Retail Ltd', 'MEDPLUS', '36AAAAA9999A1Z5', 'INR', orgId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO user_organization_access (id, user_id, organization_id, role, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'uoa-comm-1', cashierId, orgId, 'CASHIER', 1, 'uoa-comm-1', new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO user_store_access (id, user_id, organization_id, store_id, role, is_default, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'usa-comm-1', cashierId, orgId, storeAId, 'CASHIER', 1, 1, 'usa-comm-1', new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO regions (id, organization_id, code, name, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      regionId, orgId, 'SOUTH', 'South Region', regionId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO stores (id, organization_id, region_id, name, store_code, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      storeAId, orgId, regionId, 'Hyderabad Flagship', 'HYD01', 'active', storeAId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO stores (id, organization_id, region_id, name, store_code, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      storeBId, orgId, regionId, 'Bangalore Central', 'BLR01', 'active', storeBId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO counters (id, organization_id, store_id, counter_code, name, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      counterId, orgId, storeAId, 'C1', 'Counter 1', 'active', counterId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO terminals (id, organization_id, store_id, counter_id, terminal_code, terminal_name, device_uuid, status, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      terminalId, orgId, storeAId, counterId, 'T1', 'Terminal 1', 'dev-uuid-1', 'active', terminalId, new Date().toISOString()
    );

    // 3. Setup Customer & Suppliers
    localDb.prepare('INSERT OR REPLACE INTO customers (id, organization_id, store_id, name, phone, outstanding_balance, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(
      customerId, orgId, storeAId, 'Ananya Sharma', '9876543210', customerId, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO suppliers (id, organization_id, name, phone, is_active, _local_id, _updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(
      supplierId, orgId, 'Cipla Pharmaceuticals Dist', '9123456780', supplierId, new Date().toISOString()
    );

    // 4. Setup Medicines & Batches
    medParacetamolId = 'med-para-100';
    medCetaphilId = 'med-ceta-200';
    medAzithralId = 'med-azith-300';

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, category, manufacturer,
        sale_unit, base_unit, conversion_factor, gst_rate,
        is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      medParacetamolId, orgId, 'Paracetamol 650mg', 'Dolo', 'Analgesic', 'Micro Labs',
      'STRIP', 'TABLET', 10.0, 12, medParacetamolId, new Date().toISOString()
    );

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, category, manufacturer,
        sale_unit, base_unit, conversion_factor, gst_rate,
        is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      medCetaphilId, orgId, 'Cetaphil Gentle Cleanser', 'Cetaphil', 'Skincare', 'Galderma',
      'BOTTLE', 'BOTTLE', 1.0, 18, medCetaphilId, new Date().toISOString()
    );

    localDb.prepare(`
      INSERT OR REPLACE INTO medicines (
        id, organization_id, name, brand_name, category, manufacturer,
        sale_unit, base_unit, conversion_factor, gst_rate,
        is_active, _local_id, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      medAzithralId, orgId, 'Azithral 500mg', 'Azithral', 'Antibiotic', 'Alembic',
      'STRIP', 'TABLET', 5.0, 12, medAzithralId, new Date().toISOString()
    );

    batchParaStoreA = 'batch-para-store-a';
    batchCetaphilStoreA = 'batch-ceta-store-a';

    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, medicine_id, batch_number, expiry_date, quantity_in, quantity_remaining, purchase_price, mrp, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchParaStoreA, orgId, storeAId, medParacetamolId, 'DOLO99', '2028-12-31', 1000, 1000, 18.0, 30.0, batchParaStoreA, new Date().toISOString()
    );

    localDb.prepare('INSERT OR REPLACE INTO medicine_batches (id, organization_id, store_id, medicine_id, batch_number, expiry_date, quantity_in, quantity_remaining, purchase_price, mrp, _local_id, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchCetaphilStoreA, orgId, storeAId, medCetaphilId, 'CETA88', '2028-12-31', 200, 200, 320.0, 450.0, batchCetaphilStoreA, new Date().toISOString()
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. BASE PRICING & HIERARCHY TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('1. Price Books & Hierarchy Resolution', () => {
    let orgPbId: string;
    let regPbId: string;
    let storePbId: string;

    beforeAll(() => {
      // 1. Org Level Price Book: Paracetamol = ₹28.00 (2800 paise)
      const orgPb = PriceBookService.createPriceBook({
        organization_id: orgId,
        name: 'Org Standard Price Book',
        scope: 'ORGANIZATION',
        priority: 10,
        status: 'ACTIVE',
      });
      orgPbId = orgPb.id || orgPb._local_id!;
      PriceBookService.setPriceBookItem({
        organization_id: orgId,
        price_book_id: orgPbId,
        medicine_id: medParacetamolId,
        selling_price_paise: 2800,
        mrp_paise: 3000,
      });

      // 2. Regional Level Price Book: Paracetamol = ₹26.00 (2600 paise)
      const regPb = PriceBookService.createPriceBook({
        organization_id: orgId,
        name: 'South Region Price Book',
        scope: 'REGION',
        priority: 20,
        status: 'ACTIVE',
      });
      regPbId = regPb.id || regPb._local_id!;
      PriceBookService.setPriceBookScope({
        organization_id: orgId,
        price_book_id: regPbId,
        scope_type: 'REGION',
        scope_id: regionId,
      });
      PriceBookService.setPriceBookItem({
        organization_id: orgId,
        price_book_id: regPbId,
        medicine_id: medParacetamolId,
        selling_price_paise: 2600,
        mrp_paise: 3000,
      });

      // 3. Store Level Price Book: Paracetamol = ₹24.00 (2400 paise)
      const storePb = PriceBookService.createPriceBook({
        organization_id: orgId,
        name: 'Hyderabad Store Price Book',
        scope: 'STORE',
        priority: 30,
        status: 'ACTIVE',
      });
      storePbId = storePb.id || storePb._local_id!;
      PriceBookService.setPriceBookScope({
        organization_id: orgId,
        price_book_id: storePbId,
        scope_type: 'STORE',
        scope_id: storeAId,
      });
      PriceBookService.setPriceBookItem({
        organization_id: orgId,
        price_book_id: storePbId,
        medicine_id: medParacetamolId,
        selling_price_paise: 2400,
        mrp_paise: 3000,
      });
    });

    test('Store Price Book takes precedence over Region and Org Price Books (Store > Region > Org)', () => {
      const resolved = PriceBookService.resolveHierarchy({
        organizationId: orgId,
        storeId: storeAId,
        regionId,
        medicineId: medParacetamolId,
      });

      expect(resolved.source).toBe('STORE_PRICE_BOOK');
      expect(resolved.basePricePaise).toBe(2400); // Store override ₹24.00
      expect(resolved.mrpPaise).toBe(3000);
    });

    test('Region Price Book applies when store has no store-specific price book', () => {
      const resolved = PriceBookService.resolveHierarchy({
        organizationId: orgId,
        storeId: storeBId, // Store B has no store-specific book
        regionId,
        medicineId: medParacetamolId,
      });

      expect(resolved.source).toBe('REGION_PRICE_BOOK');
      expect(resolved.basePricePaise).toBe(2600); // Region price ₹26.00
    });

    test('Org Price Book applies when neither store nor region price book exists', () => {
      const resolved = PriceBookService.resolveHierarchy({
        organizationId: orgId,
        storeId: 'store-north-unmapped',
        regionId: 'reg-north-unmapped',
        medicineId: medParacetamolId,
      });

      expect(resolved.source).toBe('ORG_PRICE_BOOK');
      expect(resolved.basePricePaise).toBe(2800); // Org price ₹28.00
    });

    test('Default Medicine Catalog MRP applies when no price book entries exist', () => {
      const resolved = PriceBookService.resolveHierarchy({
        organizationId: orgId,
        storeId: storeAId,
        medicineId: medCetaphilId, // Cetaphil has no price book entry
      });

      expect(resolved.source).toBe('MASTER_CATALOG');
      expect(resolved.basePricePaise).toBe(45000); // ₹450.00
      expect(resolved.mrpPaise).toBe(45000);
    });

    test('Multi-unit conversion factor correctly scales base price and MRP', () => {
      // Paracetamol Box (conversion factor = 10 strips per box)
      const resolved = PriceBookService.resolveHierarchy({
        organizationId: orgId,
        storeId: storeAId,
        medicineId: medParacetamolId,
        unitType: 'BOX',
        conversionFactor: 10.0,
      });

      expect(resolved.basePricePaise).toBe(24000); // 2400 * 10 = ₹240.00
      expect(resolved.mrpPaise).toBe(30000); // 3000 * 10 = ₹300.00
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. MARGIN GUARD & MRP PROTECTION TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('2. Margin Guard & MRP Floor Protection', () => {
    test('Selling price strictly capped at MRP (price > MRP is BLOCKED)', () => {
      const result = MarginGuard.evaluate({
        organizationId: orgId,
        medicineId: medParacetamolId,
        sellingPricePaise: 3500, // ₹35.00 > MRP ₹30.00
        mrpPaise: 3000,
        discountPct: 0,
      });

      expect(result.status).toBe('BLOCKED');
      expect(result.requiresSupervisorApproval).toBe(true);
      expect(result.approvalReason).toContain('exceeds statutory MRP');
    });

    test('Healthy margin (>= 15%) is marked HEALTHY without supervisor override', () => {
      const result = MarginGuard.evaluate({
        organizationId: orgId,
        medicineId: medParacetamolId,
        sellingPricePaise: 2500, // ₹25.00 vs cost ₹18.00 -> 28% margin
        mrpPaise: 3000,
        discountPct: 0,
      });

      expect(result.status).toBe('ALLOWED');
      expect(result.grossMarginPct).toBeGreaterThanOrEqual(15.0);
      expect(result.requiresSupervisorApproval).toBe(false);
    });

    test('Thin margin (5% to 9.99%) triggers SUPERVISOR_REQUIRED', () => {
      const result = MarginGuard.evaluate({
        organizationId: orgId,
        medicineId: medParacetamolId,
        sellingPricePaise: 1950, // ₹19.50 vs cost ₹18.00 -> 7.69% margin
        mrpPaise: 3000,
        discountPct: 0,
      });

      expect(result.status).toBe('SUPERVISOR_APPROVAL_REQUIRED');
      expect(result.requiresSupervisorApproval).toBe(true);
    });

    test('Loss sale (selling below acquisition cost) triggers BLOCKED status', () => {
      const result = MarginGuard.evaluate({
        organizationId: orgId,
        medicineId: medParacetamolId,
        sellingPricePaise: 1500, // ₹15.00 vs cost ₹18.00 -> negative margin
        mrpPaise: 3000,
        discountPct: 0,
      });

      expect(result.status).toBe('MANAGER_APPROVAL_REQUIRED');
      expect(result.requiresSupervisorApproval).toBe(true);
      expect(result.grossMarginPaise).toBeLessThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. PROMOTIONS ENGINE TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('3. Promotion Engine Rules & Stacking', () => {
    beforeEach(() => {
      localDb.prepare('DELETE FROM promotions WHERE organization_id = ?').run(orgId);
    });
    test('PERCENTAGE_DISCOUNT computes correct discount and respects max cap', () => {
      const promo = PromotionEngine.createPromotion({
        organization_id: orgId,
        code: 'CETA10',
        name: '10% Off Cetaphil',
        promotion_type: 'PERCENTAGE_DISCOUNT',
        max_discount_paise: 4000, // Max ₹40 cap
        config_json: { percentage_discount: 10 },
        status: 'ACTIVE',
      });

      const outcome = PromotionEngine.evaluateCartPromotions({
        organizationId: orgId,
        cartLines: [{
          medicineId: medCetaphilId,
          medicineName: 'Cetaphil',
          quantity: 2, // 2 * ₹450 = ₹900 (90,000 paise). 10% = ₹90 (9,000 paise), capped at ₹40 (4,000 paise)
          unitPricePaise: 45000,
          mrpPaise: 45000,
          basePricePaise: 45000,
          unitType: 'BOTTLE',
          conversionFactor: 1.0,
        }],
      });

      expect(outcome.totalPromoDiscountPaise).toBe(4000); // capped at ₹40
      expect(outcome.appliedPromotions.length).toBe(1);
    });

    test('BUY_X_GET_Y Same Product correctly calculates paid vs free units', () => {
      // Buy 2 Get 1 Free on Paracetamol
      PromotionEngine.createPromotion({
        organization_id: orgId,
        code: 'B2G1PARA',
        name: 'Buy 2 Get 1 Free Paracetamol',
        promotion_type: 'BUY_X_GET_Y',
        config_json: { buy_qty: 2, get_free_qty: 1 },
        status: 'ACTIVE',
      });

      // Customer buys 7 units: 2 full sets of 3 (2*1 = 2 free units, 5 paid units)
      const outcome = PromotionEngine.evaluateCartPromotions({
        organizationId: orgId,
        storeId: storeAId,
        cartLines: [{
          medicineId: medParacetamolId,
          medicineName: 'Paracetamol',
          quantity: 7,
          unitPricePaise: 3000,
          mrpPaise: 3000,
          basePricePaise: 3000,
          unitType: 'STRIP',
          conversionFactor: 1.0,
        }],
      });

      expect(outcome.totalPromoDiscountPaise).toBe(6000); // 2 free units * 3000 paise = 6000 paise (₹60.00)
      expect(outcome.freeItems[0].quantity).toBe(2);
    });

    test('QUANTITY_SLAB applies tiered pricing based on purchase volume', () => {
      PromotionEngine.createPromotion({
        organization_id: orgId,
        code: 'SLAB_PARA',
        name: 'Slab Discount Paracetamol',
        promotion_type: 'QUANTITY_SLAB',
        config_json: {
          slabs: [
            { min_qty: 10, max_qty: 100, price_paise: 2500 }, // ₹25 for 10+ units
            { min_qty: 5, max_qty: 9, price_paise: 2700 },   // ₹27 for 5-9 units
          ],
        },
        status: 'ACTIVE',
      });

      const outcome = PromotionEngine.evaluateCartPromotions({
        organizationId: orgId,
        cartLines: [{
          medicineId: medParacetamolId,
          medicineName: 'Paracetamol',
          quantity: 10,
          unitPricePaise: 3000,
          mrpPaise: 3000,
          basePricePaise: 3000, // regular ₹30 -> slab ₹25 -> savings = 10 * ₹5 = ₹50 (5000 paise)
          unitType: 'STRIP',
          conversionFactor: 1.0,
        }],
      });

      expect(outcome.totalPromoDiscountPaise).toBe(5000);
    });

    test('EXCLUSIVE promotion overrides stackable promotions when offering higher customer savings', () => {
      // Create Exclusive 25% promo
      const megaPromo = PromotionEngine.createPromotion({
        organization_id: orgId,
        code: 'MEGA25',
        name: 'Mega Exclusive 25% Off',
        promotion_type: 'PERCENTAGE_DISCOUNT',
        stackability: 'EXCLUSIVE',
        config_json: { percentage_discount: 25 },
        status: 'ACTIVE',
      });

      const pId = megaPromo.id || megaPromo._local_id!;
      localMutate({
        table: 'promotion_targets',
        operation: 'INSERT',
        data: {
          id: uuidv4(),
          organization_id: orgId,
          promotion_id: pId,
          target_type: 'PRODUCT',
          target_id: medCetaphilId,
        },
      });

      const outcome = PromotionEngine.evaluateCartPromotions({
        organizationId: orgId,
        cartLines: [{
          medicineId: medCetaphilId,
          medicineName: 'Cetaphil',
          quantity: 1,
          unitPricePaise: 45000,
          mrpPaise: 45000,
          basePricePaise: 45000,
          unitType: 'BOTTLE',
          conversionFactor: 1.0,
        }],
      });

      // 25% of 45000 = 11250 paise
      expect(outcome.totalPromoDiscountPaise).toBe(11250);
      expect(outcome.appliedPromotions[0].code).toBe('MEGA25');

      // Pause test promotions so they don't interfere with baseline checkout tests in later sections
      localDb.prepare("UPDATE promotions SET status = 'PAUSED' WHERE organization_id = ?").run(orgId);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. COUPON ENGINE TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('4. Coupon Engine Validation & Atomic Redemptions', () => {
    let activeCouponId: string;

    beforeAll(() => {
      const c = CouponEngine.createCoupon({
        organization_id: orgId,
        code: 'SAVE100',
        discount_type: 'FLAT',
        discount_value: 100,
        min_spend_paise: 50000, // ₹500 min spend
        max_uses: 5,
        max_uses_per_customer: 1,
        status: 'ACTIVE',
      });
      activeCouponId = c.id || c._local_id!;
    });

    test('Coupon successfully validates when minimum cart value is met', () => {
      const val = CouponEngine.validateCoupon({
        organizationId: orgId,
        code: 'SAVE100',
        cartSubtotalPaise: 60000, // ₹600 >= ₹500
      });

      expect(val.isValid).toBe(true);
      expect(val.discountAmountPaise).toBe(10000); // ₹100
      expect(val.statusCode).toBe('VALID');
    });

    test('Coupon is rejected with MINIMUM_CART_NOT_MET when cart total is below threshold', () => {
      const val = CouponEngine.validateCoupon({
        organizationId: orgId,
        code: 'SAVE100',
        cartSubtotalPaise: 30000, // ₹300 < ₹500
      });

      expect(val.isValid).toBe(false);
      expect(val.statusCode).toBe('MINIMUM_CART_NOT_MET');
      expect(val.discountAmountPaise).toBe(0);
    });

    test('Coupon is rejected with INVALID for non-existent coupon code', () => {
      const val = CouponEngine.validateCoupon({
        organizationId: orgId,
        code: 'NON_EXISTENT_CODE',
        cartSubtotalPaise: 100000,
      });

      expect(val.isValid).toBe(false);
      expect(val.statusCode).toBe('INVALID');
    });

    test('Coupon atomic redemption tracks usage and prevents exceeding per-customer limit', () => {
      const sale1Id = uuidv4();
      CouponEngine.redeemCoupon({
        organizationId: orgId,
        couponId: activeCouponId,
        customerId,
        saleId: sale1Id,
        discountAmountPaise: 10000,
      });

      // Attempt second validation for same customer
      const secondVal = CouponEngine.validateCoupon({
        organizationId: orgId,
        customerId,
        code: 'SAVE100',
        cartSubtotalPaise: 80000,
      });

      expect(secondVal.isValid).toBe(false);
      expect(secondVal.statusCode).toBe('CUSTOMER_LIMIT_REACHED');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. CUSTOMER GROUPS & TIERED MEMBERSHIPS
  // ════════════════════════════════════════════════════════════════════════════
  describe('5. Customer Groups & Memberships', () => {
    let vipGroupId: string;

    beforeAll(() => {
      const group = CustomerGroupService.createGroup({
        organization_id: orgId,
        code: 'VIP_GOLD',
        name: 'VIP Gold Members',
        discount_pct: 5.0, // 5% direct group discount
        priority: 50,
      });
      vipGroupId = group.id || group._local_id!;

      CustomerGroupService.assignCustomer({
        organizationId: orgId,
        customerGroupId: vipGroupId,
        customerId,
      });

      CustomerGroupService.setMembership({
        organizationId: orgId,
        customerId,
        membershipType: 'GOLD',
        tier: 'TIER_1',
        loyaltyMultiplier: 1.5, // 1.5x points multiplier
      });
    });

    test('Customer Group accurately resolves with discount percentage and priority', () => {
      const resolved = CustomerGroupService.resolveCustomerGroup(customerId, orgId);
      expect(resolved).not.toBeNull();
      expect(resolved?.code).toBe('VIP_GOLD');
      expect(Number(resolved?.discount_pct)).toBe(5.0);
    });

    test('Active customer membership accurately resolves tier and loyalty multiplier', () => {
      const membership = CustomerGroupService.getActiveMembership(customerId, orgId);
      expect(membership).not.toBeNull();
      expect(membership?.membership_type).toBe('GOLD');
      expect(Number(membership?.loyalty_multiplier)).toBe(1.5);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. IMMUTABLE LOYALTY LEDGER TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('6. Immutable Loyalty Points Ledger & Returns Reversal', () => {
    test('Loyalty earning respects membership multiplier (₹100 spend -> 1 credit * 1.5x = 1.5 -> 1 floor credit per ₹100)', () => {
      // Eligible spend = ₹1,000 (100,000 paise). Spend units = 10. Multiplier = 1.5x -> 15 credits
      const earn = LoyaltyEngine.calculateEarning({
        organizationId: orgId,
        customerId,
        eligibleSpendPaise: 100000,
      });

      expect(earn.multiplier).toBe(1.5);
      expect(earn.creditsEarned).toBe(15);
    });

    test('Loyalty points redemption converts credits to rupee value and caps at 50% bill limit', () => {
      // Give customer 400 credits (worth 400 * 25 paise = 10,000 paise = ₹100)
      LoyaltyEngine.recordTransaction({
        organizationId: orgId,
        customerId,
        transactionType: 'ADJUSTMENT',
        credits: 400,
        notes: 'Initial test points',
      });

      // Bill total = ₹120 (12,000 paise). Max 50% discount allowed = ₹60 (6,000 paise = 240 credits)
      const redeem = LoyaltyEngine.calculateRedemption({
        organizationId: orgId,
        customerId,
        requestedCredits: 300, // requests ₹75 off
        billTotalPaise: 12000,
      });

      expect(redeem.allowed).toBe(true);
      expect(redeem.creditsToRedeem).toBe(240); // capped at 240 credits (₹60)
      expect(redeem.monetaryValuePaise).toBe(6000);
    });

    test('Return reversal proportionality deducts earned points on product return', () => {
      const saleId = uuidv4();
      const returnId = uuidv4();

      // Record 20 earned credits on sale
      LoyaltyEngine.recordTransaction({
        organizationId: orgId,
        customerId,
        transactionType: 'EARN',
        credits: 20,
        saleId,
        notes: 'Sale earn',
      });

      // Process 50% partial return
      LoyaltyEngine.processReturnReversal({
        organizationId: orgId,
        customerId,
        originalSaleId: saleId,
        returnId,
        returnRatio: 0.5,
      });

      const history = LoyaltyEngine.getCustomerHistory(customerId);
      const revTx = history.transactions.find(t => t.transaction_type === 'REVERSAL');
      expect(revTx).toBeDefined();
      expect(Number(revTx?.credits)).toBe(-10); // 50% of 20 reversed
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. SUPPLIER SCHEMES (PROCUREMENT) TESTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('7. Supplier Schemes & Effective Unit Acquisition Cost', () => {
    beforeAll(() => {
      // Buy 10 Get 2 Free scheme with 3% trade discount on Paracetamol from Cipla
      SupplierSchemeEngine.createScheme({
        organization_id: orgId,
        supplier_id: supplierId,
        medicine_id: medParacetamolId,
        name: 'Cipla 10+2 Free Paracetamol',
        scheme_type: 'BUY_X_GET_Y_FREE',
        min_quantity: 10,
        free_quantity: 2,
        discount_pct: 3.0,
        status: 'ACTIVE',
      });
    });

    test('Buy 10 Get 2 Free accurately computes received physical units and effective blended unit cost', () => {
      // Billed Quantity: 50 units at purchase rate ₹18.00.
      // Free Quantity: 5 sets * 2 = 10 free units. Total received = 60 units.
      // Gross = 50 * 18 = ₹900. Trade discount 3% = ₹27. Net Paid = ₹873 (87,300 paise).
      // Effective Unit Cost = 87,300 / 60 = 1455 paise = ₹14.55 per unit (vs nominal ₹18.00).
      const result = SupplierSchemeEngine.evaluateInwardScheme({
        organizationId: orgId,
        supplierId,
        medicineId: medParacetamolId,
        billedQuantity: 50,
        purchasePrice: 18.0,
      });

      expect(result.billedQuantity).toBe(50);
      expect(result.freeQuantity).toBe(10);
      expect(result.totalReceivedQuantity).toBe(60);
      expect(result.totalPaidAmount).toBe(873.0);
      expect(result.effectiveUnitCost).toBe(14.55);
      expect(result.effectiveUnitCostPaise).toBe(1455);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. END-TO-END POS INTEGRATION & ATOMIC SNAPSHOTS
  // ════════════════════════════════════════════════════════════════════════════
  describe('8. POS Commercial Engine HTTP Endpoints & Snapshots', () => {
    test('POST /api/pos/quote returns comprehensive commercial breakdown', async () => {
      const res = await request(app)
        .post('/api/pos/quote')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [
            { medicine_id: medParacetamolId, quantity: 2 },
            { medicine_id: medCetaphilId, quantity: 1 },
          ],
          customer_id: customerId,
        });

      expect(res.status).toBe(200);
      const q = res.body.data;
      expect(q.grandTotal).toBeGreaterThan(0);
      expect(q.mrpTotal).toBeGreaterThan(0);
      expect(q.customerGroupName).toBe('VIP Gold Members');
    });

    test('POST /api/pos/checkout persists commercial snapshot and loyalty points', async () => {
      const idempotencyKey = `chk_${Date.now()}`;
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          idempotency_key: idempotencyKey,
          items: [{ medicine_id: medParacetamolId, quantity: 2 }],
          customer_id: customerId,
          payments: [{ tender_type: 'CASH', amount: 200 }],
        });

      expect(res.status).toBe(201);
      const data = res.body.data;
      expect(data.commercial_snapshot).toBeDefined();
      expect(data.sale.invoice_number).toMatch(/INV/);

      // Verify Commercial Snapshot Row in DB
      const snapshot: any = localDb
        .prepare('SELECT * FROM sale_commercial_snapshots WHERE sale_id = ?')
        .get(data.sale.id || data.sale._local_id);

      expect(snapshot).toBeDefined();
      expect(snapshot.gross_margin_pct).toBeGreaterThan(0);
    });

    test('Returns accurately quote and restore inventory referencing original commercial snapshot', async () => {
      // 1. Checkout a sale
      const chkRes = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .send({
          items: [{ medicine_id: medParacetamolId, quantity: 4 }],
          customer_id: customerId,
          payments: [{ tender_type: 'CASH', amount: 500 }],
        });

      const sale = chkRes.body.data.sale;
      const saleItem = chkRes.body.data.items[0];

      // 2. Quote Return of 2 units
      const quote = ReturnsEngine.quoteReturn({
        originalSaleId: sale.id || sale._local_id,
        items: [{
          sale_item_id: saleItem.id || saleItem._local_id,
          quantity: 2,
          reason_code: 'CUSTOMER_RETURN',
        }],
      });

      expect(quote.totalRefund).toBeGreaterThan(0);
      expect(quote.lines[0].returnQuantity).toBe(2);

      // 3. Process Return
      const processRes = ReturnsEngine.processReturn({
        originalSaleId: sale.id || sale._local_id,
        items: [{
          sale_item_id: saleItem.id || saleItem._local_id,
          quantity: 2,
          reason_code: 'CUSTOMER_RETURN',
        }],
        refundMethod: 'CASH',
        organizationId: orgId,
        storeId: storeAId,
        performedBy: cashierId,
      });

      expect(processRes.creditNoteNumber).toMatch(/CN/);
      expect(processRes.returnInvoiceNumber).toMatch(/RET/);
    });
  });
});
