import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { PriceBookService } from '../services/commercial/priceBookService';
import { PromotionEngine } from '../services/commercial/promotionEngine';
import { CouponEngine } from '../services/commercial/couponEngine';
import { CustomerGroupService } from '../services/commercial/customerGroupService';
import { LoyaltyEngine } from '../services/commercial/loyaltyEngine';
import { SupplierSchemeEngine } from '../services/commercial/supplierSchemeEngine';
import { POSSessionService } from '../services/posSession';
import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { AppError } from '../lib/appError';

export const commercialRouter = Router();

// ── 1. PRICE BOOKS ───────────────────────────────────────────────────────────
commercialRouter.get('/price-books', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || null,
    });
    const priceBooks = PriceBookService.listPriceBooks(session.organizationId);
    res.json({ data: priceBooks });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/price-books', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || null,
    });
    const pb = PriceBookService.createPriceBook({
      ...req.body,
      organization_id: session.organizationId,
      created_by: session.userId,
    });
    res.status(201).json({ data: pb });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/price-books/:id/items', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const item = PriceBookService.setPriceBookItem({
      ...req.body,
      price_book_id: req.params.id,
      organization_id: session.organizationId,
    });
    res.status(201).json({ data: item });
  } catch (err) {
    next(err);
  }
});

// ── 2. PROMOTIONS ────────────────────────────────────────────────────────────
commercialRouter.get('/promotions', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || null,
    });
    const promos = PromotionEngine.listPromotions(session.organizationId);
    res.json({ data: promos });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/promotions', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const promo = PromotionEngine.createPromotion({
      ...req.body,
      organization_id: session.organizationId,
      created_by: session.userId,
    });
    res.status(201).json({ data: promo });
  } catch (err) {
    next(err);
  }
});

commercialRouter.patch('/promotions/:id/status', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { status } = req.body;
    localMutate({
      table: 'promotions',
      operation: 'UPDATE',
      data: {
        _local_id: req.params.id,
        status,
      },
    });
    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

// ── 3. COUPONS ───────────────────────────────────────────────────────────────
commercialRouter.get('/coupons', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const coupons = CouponEngine.listCoupons(session.organizationId);
    res.json({ data: coupons });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/coupons', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const coupon = CouponEngine.createCoupon({
      ...req.body,
      organization_id: session.organizationId,
    });
    res.status(201).json({ data: coupon });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/coupons/validate', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || null,
    });
    const { code, cart_subtotal_paise, customer_id, medicine_ids, is_offline } = req.body;

    const validation = CouponEngine.validateCoupon({
      organizationId: session.organizationId,
      storeId: session.storeId,
      customerId: customer_id || null,
      code,
      cartSubtotalPaise: Number(cart_subtotal_paise || 0),
      eligibleMedicineIds: medicine_ids || [],
      isOffline: Boolean(is_offline),
    });

    res.json({ data: validation });
  } catch (err) {
    next(err);
  }
});

// ── 4. CUSTOMER GROUPS & MEMBERSHIPS ─────────────────────────────────────────
commercialRouter.get('/customer-groups', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const groups = CustomerGroupService.listGroups(session.organizationId);
    res.json({ data: groups });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/customer-groups', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const group = CustomerGroupService.createGroup({
      ...req.body,
      organization_id: session.organizationId,
    });
    res.status(201).json({ data: group });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/customer-groups/assign', requireAuth, requireRole('CASHIER', 'PHARMACIST', 'OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const { customer_group_id, customer_id, start_at, end_at } = req.body;
    const member = CustomerGroupService.assignCustomer({
      organizationId: session.organizationId,
      customerGroupId: customer_group_id,
      customerId: customer_id,
      startAt: start_at,
      endAt: end_at,
      assignedBy: session.userId,
    });
    res.status(201).json({ data: member });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/memberships', requireAuth, requireRole('CASHIER', 'PHARMACIST', 'OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const membership = CustomerGroupService.setMembership({
      ...req.body,
      organizationId: session.organizationId,
    });
    res.status(201).json({ data: membership });
  } catch (err) {
    next(err);
  }
});

// ── 5. LOYALTY PROGRAM & LEDGER ──────────────────────────────────────────────
commercialRouter.get('/loyalty/program', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const program = LoyaltyEngine.getOrCreateProgram(session.organizationId);
    res.json({ data: program });
  } catch (err) {
    next(err);
  }
});

commercialRouter.get('/loyalty/account/:customerId', requireAuth, async (req, res, next) => {
  try {
    const history = LoyaltyEngine.getCustomerHistory(req.params.customerId);
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/loyalty/adjust', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const { customer_id, credits, notes } = req.body;
    const tx = LoyaltyEngine.recordTransaction({
      organizationId: session.organizationId,
      customerId: customer_id,
      transactionType: 'ADJUSTMENT',
      credits: Number(credits),
      notes: notes || `Manual balance adjustment by ${session.userId}`,
    });
    res.status(201).json({ data: tx });
  } catch (err) {
    next(err);
  }
});

// ── 6. SUPPLIER SCHEMES ──────────────────────────────────────────────────────
commercialRouter.get('/supplier-schemes', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const schemes = SupplierSchemeEngine.listSchemes(session.organizationId);
    res.json({ data: schemes });
  } catch (err) {
    next(err);
  }
});

commercialRouter.post('/supplier-schemes', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
    });
    const scheme = SupplierSchemeEngine.createScheme({
      ...req.body,
      organization_id: session.organizationId,
    });
    res.status(201).json({ data: scheme });
  } catch (err) {
    next(err);
  }
});
