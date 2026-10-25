// orders.ts — Enterprise Omnichannel Order Management & Fulfilment Router
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { OrderLifecycleService } from '../services/oms/orderLifecycleService';
import { OrderQuoteService } from '../services/oms/orderQuoteService';
import { FulfilmentEngine } from '../services/oms/fulfilmentEngine';
import { OrderPickPackService } from '../services/oms/orderPickPackService';
import { OrderPickupService } from '../services/oms/orderPickupService';
import { OrderToSaleConverter } from '../services/oms/orderToSaleConverter';
import { OrderSubstitutionService } from '../services/oms/orderSubstitutionService';
import { RepeatOrderService } from '../services/oms/repeatOrderService';
import { OrderEventService } from '../services/oms/orderEventService';
import { CustomerAddressService } from '../services/oms/customerAddressService';
import { OrderStateMachine } from '../services/oms/orderStateMachine';
import { localDb } from '../local-db';
import { AppError } from '../lib/appError';

export const ordersRouter = Router();

// Helper to resolve org ID from user
function resolveOrgId(req: any): string {
  return req.user?.organization_id || req.user?.clinic_id || 'default-org';
}

// ── 1. GET /api/orders — List Orders Command Center ─────────────────────────
ordersRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const {
      store_id,
      channel,
      fulfilment_type,
      status,
      prescription_status,
      payment_status,
      priority,
      search,
      customer_id,
      limit = 50,
      offset = 0,
    } = req.query;

    let query = `
      SELECT o.*, 
             c.name as customer_name, c.phone as customer_phone,
             s.name as fulfilment_store_name,
             (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND _deleted = 0) as item_count,
             (SELECT SUM(requested_quantity) FROM order_items WHERE order_id = o.id AND _deleted = 0) as total_units
      FROM orders o
      LEFT JOIN customers c ON (o.customer_id = c.id OR o.customer_id = c._local_id)
      LEFT JOIN stores s ON (o.fulfilment_store_id = s.id OR o.fulfilment_store_id = s._local_id)
      WHERE o.organization_id = ? AND o._deleted = 0 AND (o.deleted_at IS NULL)
    `;
    const params: any[] = [orgId];

    if (store_id) {
      query += ` AND (o.fulfilment_store_id = ? OR o.requested_store_id = ?)`;
      params.push(store_id, store_id);
    }
    if (channel) {
      query += ` AND o.channel = ?`;
      params.push(channel);
    }
    if (fulfilment_type) {
      query += ` AND o.fulfilment_type = ?`;
      params.push(fulfilment_type);
    }
    if (status) {
      query += ` AND o.status = ?`;
      params.push(status);
    }
    if (prescription_status) {
      query += ` AND o.prescription_status = ?`;
      params.push(prescription_status);
    }
    if (payment_status) {
      query += ` AND o.payment_status = ?`;
      params.push(payment_status);
    }
    if (priority) {
      query += ` AND o.priority = ?`;
      params.push(priority);
    }
    if (customer_id) {
      query += ` AND o.customer_id = ?`;
      params.push(customer_id);
    }
    if (search) {
      const s = `%${search}%`;
      query += ` AND (o.order_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)`;
      params.push(s, s, s);
    }

    query += ` ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const rows = localDb.prepare(query).all(...params);

    // Count total matching
    let countQuery = `
      SELECT COUNT(*) as total FROM orders o
      LEFT JOIN customers c ON (o.customer_id = c.id OR o.customer_id = c._local_id)
      WHERE o.organization_id = ? AND o._deleted = 0 AND (o.deleted_at IS NULL)
    `;
    const countParams: any[] = [orgId];
    if (store_id) {
      countQuery += ` AND (o.fulfilment_store_id = ? OR o.requested_store_id = ?)`;
      countParams.push(store_id, store_id);
    }
    if (status) {
      countQuery += ` AND o.status = ?`;
      countParams.push(status);
    }
    if (customer_id) {
      countQuery += ` AND o.customer_id = ?`;
      countParams.push(customer_id);
    }
    const countRow: any = localDb.prepare(countQuery).get(...countParams);

    res.json({
      data: rows,
      total: Number(countRow?.total || 0),
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (err) {
    next(err);
  }
});

// ── 2. GET /api/orders/metrics — Summary Statistics for Dashboard ───────────
ordersRouter.get('/metrics', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const storeId = req.query.store_id as string;

    let filter = `organization_id = ? AND _deleted = 0 AND (deleted_at IS NULL)`;
    const params: any[] = [orgId];
    if (storeId) {
      filter += ` AND (fulfilment_store_id = ? OR requested_store_id = ?)`;
      params.push(storeId, storeId);
    }

    const rows: any[] = localDb
      .prepare(
        `SELECT 
           COUNT(*) as total_orders,
           SUM(CASE WHEN status IN ('CREATED', 'DRAFT') THEN 1 ELSE 0 END) as new_orders,
           SUM(CASE WHEN prescription_status = 'PENDING_REVIEW' THEN 1 ELSE 0 END) as rx_pending,
           SUM(CASE WHEN status = 'CONFIRMED' OR status = 'INVENTORY_RESERVED' THEN 1 ELSE 0 END) as awaiting_pick,
           SUM(CASE WHEN status = 'PICKING' THEN 1 ELSE 0 END) as picking,
           SUM(CASE WHEN status = 'PACKED' THEN 1 ELSE 0 END) as packed,
           SUM(CASE WHEN status = 'READY_FOR_PICKUP' THEN 1 ELSE 0 END) as ready_for_pickup,
           SUM(CASE WHEN status = 'READY_FOR_DISPATCH' THEN 1 ELSE 0 END) as ready_for_dispatch,
           SUM(CASE WHEN status = 'PARTIALLY_FULFILLED' THEN 1 ELSE 0 END) as partial,
           SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_today,
           SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
           SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'COMPLETED' THEN grand_total ELSE 0 END) as completed_value
         FROM orders
         WHERE ${filter}`
      )
      .all(...params);

    const m = rows[0] || {};
    res.json({
      data: {
        totalOrders: Number(m.total_orders || 0),
        newOrders: Number(m.new_orders || 0),
        rxPending: Number(m.rx_pending || 0),
        awaitingPick: Number(m.awaiting_pick || 0),
        picking: Number(m.picking || 0),
        packed: Number(m.packed || 0),
        readyForPickup: Number(m.ready_for_pickup || 0),
        readyForDispatch: Number(m.ready_for_dispatch || 0),
        partial: Number(m.partial || 0),
        completedToday: Number(m.completed_today || 0),
        cancelled: Number(m.cancelled || 0),
        failed: Number(m.failed || 0),
        completedValue: Number(m.completed_value || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── 3. GET /api/orders/fulfilment/candidates — Candidate Stores ─────────────
ordersRouter.get('/fulfilment/candidates', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const itemsJson = req.query.items as string;
    const items = itemsJson ? JSON.parse(itemsJson) : [];
    const fulfilmentType = (req.query.fulfilment_type as any) || 'STORE_PICKUP';
    const requestedStoreId = (req.query.requested_store_id as string) || null;

    const candidates = FulfilmentEngine.evaluateCandidates({
      organizationId: orgId,
      items,
      fulfilmentType,
      requestedStoreId,
    });

    res.json({ data: candidates });
  } catch (err) {
    next(err);
  }
});

// ── 4. GET /api/orders/picking/queue — Store Pick Queue ───────────────────────
ordersRouter.get('/picking/queue', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const storeId = (req.query.store_id as string) || (req.headers['x-store-id'] as string);

    if (!storeId) {
      throw new AppError(400, 'store_id parameter or x-store-id header is required', 'STORE_REQUIRED');
    }

    const queue = OrderPickPackService.getStorePickQueue({
      organizationId: orgId,
      storeId,
    });

    res.json({ data: queue });
  } catch (err) {
    next(err);
  }
});

// ── 5. POST /api/orders/quote — Generate Server-Side Cart Quote ──────────────
ordersRouter.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const {
      store_id,
      customer_id,
      channel,
      fulfilment_type,
      items,
      coupon_code,
      redeem_loyalty_credits,
      delivery_charge_paise,
    } = req.body;

    const quote = OrderQuoteService.generateQuote({
      organizationId: orgId,
      storeId: store_id || null,
      customerId: customer_id || null,
      channel: channel || 'RETAIL',
      fulfilmentType: fulfilment_type || 'STORE_PICKUP',
      items: items || [],
      couponCode: coupon_code || null,
      redeemLoyaltyCredits: Number(redeem_loyalty_credits || 0),
      deliveryChargePaiseOverride: delivery_charge_paise != null ? Number(delivery_charge_paise) : null,
    });

    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

// ── 6. POST /api/orders/draft — Create Unreserved Draft Order ─────────────────
ordersRouter.post('/draft', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderLifecycleService.createDraftOrder({
      organizationId: orgId,
      customerId: req.body.customer_id,
      patientId: req.body.patient_id,
      source: req.body.source || 'MANUAL',
      channel: req.body.channel || 'RETAIL',
      fulfilmentType: req.body.fulfilment_type || 'STORE_PICKUP',
      requestedStoreId: req.body.requested_store_id,
      items: req.body.items || [],
      couponCode: req.body.coupon_code,
      redeemLoyaltyCredits: Number(req.body.redeem_loyalty_credits || 0),
      customerNotes: req.body.customer_notes,
      internalNotes: req.body.internal_notes,
      priority: req.body.priority || 'NORMAL',
      createdBy: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 7. POST /api/orders/confirm — Authoritative Order Confirmation ───────────
ordersRouter.post('/confirm', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderLifecycleService.confirmOrder({
      organizationId: orgId,
      customerId: req.body.customer_id,
      patientId: req.body.patient_id,
      source: req.body.source || 'MANUAL',
      channel: req.body.channel || 'RETAIL',
      fulfilmentType: req.body.fulfilment_type || 'STORE_PICKUP',
      requestedStoreId: req.body.requested_store_id,
      addressId: req.body.address_id,
      deliveryAddress: req.body.delivery_address,
      items: req.body.items || [],
      couponCode: req.body.coupon_code,
      redeemLoyaltyCredits: Number(req.body.redeem_loyalty_credits || 0),
      customerNotes: req.body.customer_notes,
      internalNotes: req.body.internal_notes,
      priority: req.body.priority || 'NORMAL',
      idempotencyKey: req.body.idempotency_key,
      prepaidPayment: req.body.prepaid_payment,
      createdBy: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 8. GET /api/orders/:id — Full Order Detail Tree ──────────────────────────
ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const orderId = req.params.id;

    const order: any = localDb
      .prepare(
        `SELECT o.*, 
                c.name as customer_name, c.phone as customer_phone, c.email as customer_email,
                s.name as store_name, s.store_code
         FROM orders o
         LEFT JOIN customers c ON (o.customer_id = c.id OR o.customer_id = c._local_id)
         LEFT JOIN stores s ON (o.fulfilment_store_id = s.id OR o.fulfilment_store_id = s._local_id)
         WHERE (o.id = ? OR o._local_id = ? OR o.order_number = ?) AND o.organization_id = ? AND o._deleted = 0`
      )
      .get(orderId, orderId, orderId, orgId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    const items = localDb
      .prepare('SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0 ORDER BY created_at ASC')
      .all(order.id);

    const addressSnapshot = localDb
      .prepare('SELECT * FROM order_address_snapshots WHERE order_id = ?')
      .get(order.id);

    const commercialSnapshot = OrderQuoteService.getCommercialSnapshot(order.id, orgId);

    const fulfilments = localDb
      .prepare('SELECT * FROM order_fulfilments WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const fulfilmentItems = localDb
      .prepare('SELECT * FROM order_fulfilment_items WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const packages = localDb
      .prepare('SELECT * FROM order_packages WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const packageItems = localDb
      .prepare('SELECT * FROM order_package_items WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const paymentTransactions = localDb
      .prepare('SELECT * FROM payment_transactions WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const substitutions = localDb
      .prepare('SELECT * FROM order_substitutions WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const refunds = localDb
      .prepare('SELECT * FROM order_refunds WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    const timeline = OrderEventService.getTimeline(order.id, orgId);

    res.json({
      data: {
        ...order,
        items,
        addressSnapshot,
        commercialSnapshot,
        fulfilments,
        fulfilmentItems,
        packages,
        packageItems,
        paymentTransactions,
        substitutions,
        refunds,
        timeline,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── 9. POST /api/orders/:id/cancel — Cancel Order ───────────────────────────
ordersRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderLifecycleService.cancelOrder({
      orderId: req.params.id,
      organizationId: orgId,
      reason: req.body.reason || 'CUSTOMER_REQUEST',
      cancelledByUserId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 10. POST /api/orders/:id/reassign — Reassign Fulfilment Store ───────────
ordersRouter.post('/:id/reassign', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderLifecycleService.reassignFulfilmentStore({
      orderId: req.params.id,
      organizationId: orgId,
      targetStoreId: req.body.target_store_id,
      reassignedByUserId: req.user!.id,
      reason: req.body.reason,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 11. POST /api/orders/:id/pick/start — Start Picking ───────────────────────
ordersRouter.post('/:id/pick/start', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    OrderPickPackService.startPicking({
      orderId: req.params.id,
      organizationId: orgId,
      pickerUserId: req.user!.id,
      pickerName: (req.user as any)?.name || req.user?.email || 'Staff',
    });
    res.json({ success: true, message: 'Picking started' });
  } catch (err) {
    next(err);
  }
});

// ── 12. POST /api/orders/:id/pick/item — Barcode Scan & Confirm Pick ─────────
ordersRouter.post('/:id/pick/item', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderPickPackService.pickItem({
      orderId: req.params.id,
      orderItemId: req.body.order_item_id,
      organizationId: orgId,
      scannedBarcode: req.body.barcode,
      pickedQuantity: Number(req.body.quantity || 1),
      pickedBatchId: req.body.batch_id || null,
      pickerUserId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 13. POST /api/orders/:id/pick/shortage — Record Pick Shortage ────────────
ordersRouter.post('/:id/pick/shortage', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    OrderPickPackService.recordShortage({
      orderId: req.params.id,
      orderItemId: req.body.order_item_id,
      organizationId: orgId,
      foundQuantity: Number(req.body.found_quantity || 0),
      reason: req.body.reason,
      pickerUserId: req.user!.id,
    });
    res.json({ success: true, message: 'Shortage recorded' });
  } catch (err) {
    next(err);
  }
});

// ── 14. POST /api/orders/:id/pack — Pack Order & Produce Label ───────────────
ordersRouter.post('/:id/pack', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const pkg = OrderPickPackService.packOrder({
      orderId: req.params.id,
      organizationId: orgId,
      packedByUserId: req.user!.id,
      packedByName: (req.user as any)?.name || req.user?.email || 'Staff',
      specialInstructions: req.body.special_instructions,
    });
    res.json({ data: pkg });
  } catch (err) {
    next(err);
  }
});

// ── 15. POST /api/orders/:id/pickup/verify — Verify Pickup PIN / QR ─────────
ordersRouter.post('/:id/pickup/verify', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderPickupService.verifyPickupCode({
      orderId: req.params.id,
      organizationId: orgId,
      pickupCode: req.body.pickup_code,
      verifiedByUserId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 16. POST /api/orders/:id/complete-pickup — Order to Sale Conversion ─────
ordersRouter.post('/:id/complete-pickup', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderToSaleConverter.convertToSale({
      orderId: req.params.id,
      organizationId: orgId,
      storeId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      counterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      terminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
      servedByUserId: req.user!.id,
      payments: req.body.payments || [],
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 17. POST /api/orders/:id/substitute — Request Substitution ───────────────
ordersRouter.post('/:id/substitute', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const sub = OrderSubstitutionService.requestSubstitution({
      orderId: req.params.id,
      orderItemId: req.body.order_item_id,
      organizationId: orgId,
      suggestedMedicineId: req.body.suggested_medicine_id,
      reason: req.body.reason || 'OUT_OF_STOCK',
      requestedByUserId: req.user!.id,
    });
    res.status(201).json({ data: sub });
  } catch (err) {
    next(err);
  }
});

// ── 18. POST /api/orders/substitutions/:subId/approve — Approve Substitution ──
ordersRouter.post('/substitutions/:subId/approve', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = OrderSubstitutionService.approveSubstitution({
      substitutionId: req.params.subId,
      organizationId: orgId,
      approvedByUserId: req.user!.id,
      approvedByRole: req.user!.role,
      customerConfirmed: req.body.customer_confirmed !== false,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 19. POST /api/orders/repeat/:sourceId — Evaluate Repeat Order ────────────
ordersRouter.post('/repeat/:sourceId', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = RepeatOrderService.evaluateRepeatOrder({
      sourceId: req.params.sourceId,
      organizationId: orgId,
      storeId: (req.query.store_id as string) || null,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 20. GET /api/orders/:id/tracking — Customer Tracking Timeline ───────────
ordersRouter.get('/:id/tracking', async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const order: any = localDb
      .prepare('SELECT id, order_number, status, fulfilment_type, placed_at, ready_at, completed_at FROM orders WHERE id = ? OR order_number = ?')
      .get(orderId, orderId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    const display = OrderStateMachine.getCustomerDisplayStatus(order.status, order.fulfilment_type);

    res.json({
      data: {
        orderNumber: order.order_number,
        status: order.status,
        displayStatus: display.title,
        currentStep: display.step,
        description: display.description,
        placedAt: order.placed_at,
        readyAt: order.ready_at,
        completedAt: order.completed_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── 21. GET /api/orders/customers/:customerId/addresses — Customer Addresses ──
ordersRouter.get('/customers/:customerId/addresses', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const addresses = CustomerAddressService.getCustomerAddresses(orgId, req.params.customerId);
    res.json({ data: addresses });
  } catch (err) {
    next(err);
  }
});

// ── 22. POST /api/orders/customers/:customerId/addresses — Save Address ──────
ordersRouter.post('/customers/:customerId/addresses', requireAuth, async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const addr = CustomerAddressService.saveAddress({
      id: req.body.id,
      organizationId: orgId,
      customerId: req.params.customerId,
      label: req.body.label,
      recipientName: req.body.recipient_name,
      phone: req.body.phone,
      addressLine1: req.body.address_line_1,
      addressLine2: req.body.address_line_2,
      locality: req.body.locality,
      city: req.body.city,
      state: req.body.state,
      stateCode: req.body.state_code,
      pincode: req.body.pincode,
      landmark: req.body.landmark,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      isDefault: req.body.is_default,
      deliveryInstructions: req.body.delivery_instructions,
    });
    res.status(201).json({ data: addr });
  } catch (err) {
    next(err);
  }
});
