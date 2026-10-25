// orderLifecycleService.ts — Core Order Lifecycle & Orchestration Service
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { DocumentNumberingService } from '../documentNumbering';
import { OrderStateMachine } from './orderStateMachine';
import { OrderQuoteService, OrderQuoteRequest } from './orderQuoteService';
import { FulfilmentEngine } from './fulfilmentEngine';
import { OrderReservationService } from './orderReservationService';
import { OrderPickupService } from './orderPickupService';
import { OrderEventService } from './orderEventService';
import { CustomerAddressService } from './customerAddressService';
import { Money } from '../../lib/money';
import {
  Order,
  OrderItem,
  OrderStatus,
  OrderPrescriptionStatus,
  OrderPaymentStatus,
  OrderFulfilmentStatus,
  OrderPriority,
  OrderSource,
  OrderChannel,
  FulfilmentType,
  OrderCancellationReason,
} from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export interface CreateOrderParams {
  organizationId: string;
  customerId: string;
  patientId?: string | null;
  source?: OrderSource;
  channel?: OrderChannel;
  fulfilmentType?: FulfilmentType;
  requestedStoreId?: string | null;
  addressId?: string | null;
  deliveryAddress?: {
    recipient_name: string;
    phone: string;
    address_line_1: string;
    address_line_2?: string;
    locality?: string;
    city: string;
    state: string;
    pincode: string;
    landmark?: string;
    latitude?: number;
    longitude?: number;
    delivery_instructions?: string;
  } | null;
  items: Array<{
    medicine_id: string;
    quantity: number;
    unit_type?: string;
    conversion_factor?: number;
    prescription_id?: string | null;
    prescription_item_id?: string | null;
    notes?: string;
  }>;
  couponCode?: string | null;
  redeemLoyaltyCredits?: number;
  customerNotes?: string | null;
  internalNotes?: string | null;
  priority?: OrderPriority;
  idempotencyKey?: string | null;
  prepaidPayment?: {
    tender_type: string;
    amount: number;
    reference_number?: string;
    provider?: string;
  } | null;
  createdBy?: string;
}

export class OrderLifecycleService {
  /**
   * Create an unconfirmed Draft order (no inventory reservation)
   */
  static createDraftOrder(params: CreateOrderParams): { orderId: string; order: Order; items: OrderItem[] } {
    const {
      organizationId,
      customerId,
      patientId = null,
      source = 'MANUAL',
      channel = 'RETAIL',
      fulfilmentType = 'STORE_PICKUP',
      requestedStoreId = null,
      items,
      couponCode = null,
      redeemLoyaltyCredits = 0,
      customerNotes = null,
      internalNotes = null,
      priority = 'NORMAL',
      createdBy = 'SYSTEM',
    } = params;

    const customer: any = localDb
      .prepare('SELECT * FROM customers WHERE id = ? OR _local_id = ?')
      .get(customerId, customerId);

    if (!customer) {
      throw new AppError(404, `Customer not found: ${customerId}`, 'CUSTOMER_NOT_FOUND');
    }

    const quote = OrderQuoteService.generateQuote({
      organizationId,
      storeId: requestedStoreId,
      customerId,
      channel,
      fulfilmentType,
      items,
      couponCode,
      redeemLoyaltyCredits,
    });

    const orderId = uuidv4();
    const orderNumber = `DRAFT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const nowIso = new Date().toISOString();

    const orderRecord = localMutate({
      table: 'orders',
      operation: 'INSERT',
      data: {
        id: orderId,
        _local_id: orderId,
        organization_id: organizationId,
        order_number: orderNumber,
        customer_id: customerId,
        patient_id: patientId,
        source,
        channel,
        fulfilment_type: fulfilmentType,
        requested_store_id: requestedStoreId,
        status: 'DRAFT',
        prescription_status: quote.hasPrescriptionMedication ? 'PENDING_REVIEW' : 'NOT_REQUIRED',
        payment_status: 'UNPAID',
        fulfilment_status: 'UNASSIGNED',
        priority,
        customer_notes: customerNotes,
        internal_notes: internalNotes,
        subtotal_paise: quote.subtotalPaise,
        subtotal: quote.subtotal,
        discount_total_paise: quote.discountTotalPaise,
        discount_total: quote.discountTotal,
        tax_total_paise: quote.taxTotalPaise,
        tax_total: quote.taxTotal,
        loyalty_redemption_paise: quote.loyaltyRedemptionPaise,
        loyalty_redemption_credits: quote.loyaltyRedemptionCredits,
        delivery_charge_paise: quote.deliveryChargePaise,
        delivery_charge: quote.deliveryCharge,
        round_off_paise: quote.roundOffPaise,
        round_off: quote.roundOff,
        grand_total_paise: quote.grandTotalPaise,
        grand_total: quote.grandTotal,
        quote_expires_at: quote.expiresAt,
        placed_at: nowIso,
        created_by: createdBy,
        created_at: nowIso,
        updated_at: nowIso,
      },
    });

    const insertedItems: OrderItem[] = [];
    for (const qLine of quote.commercialQuote.lines) {
      const origItem = items.find(i => i.medicine_id === qLine.medicineId);
      const itemId = uuidv4();
      const itemRecord = localMutate({
        table: 'order_items',
        operation: 'INSERT',
        data: {
          id: itemId,
          _local_id: itemId,
          order_id: orderId,
          organization_id: organizationId,
          medicine_id: qLine.medicineId,
          medicine_name: qLine.medicineName,
          requested_unit: qLine.unitType,
          conversion_factor: qLine.conversionFactor,
          requested_quantity: qLine.requestedQuantity,
          base_quantity: qLine.baseQuantity,
          fulfilled_quantity: 0,
          cancelled_quantity: 0,
          substituted_quantity: 0,
          prescription_required: (origItem as any)?.prescription_required || (origItem as any)?.prescription_id ? 1 : 0,
          prescription_item_id: origItem?.prescription_item_id || null,
          prescription_id: origItem?.prescription_id || null,
          mrp_paise: qLine.mrpPaise,
          unit_price_paise: qLine.effectiveUnitPricePaise || qLine.basePricePaise,
          discount_amount_paise: qLine.totalDiscountPaise || 0,
          taxable_amount_paise: qLine.taxableAmountPaise,
          tax_amount_paise: qLine.taxAmountPaise,
          gst_rate: qLine.gstRate,
          line_total_paise: qLine.lineTotalPaise,
          status: 'REQUESTED',
          notes: origItem?.notes || null,
          created_at: nowIso,
          updated_at: nowIso,
        },
      });
      insertedItems.push(itemRecord);
    }

    return { orderId, order: orderRecord, items: insertedItems };
  }

  /**
   * Authoritative Order Confirmation Flow
   */
  static confirmOrder(params: CreateOrderParams): { orderId: string; orderNumber: string; order: Order; items: OrderItem[] } {
    const {
      organizationId,
      customerId,
      patientId = null,
      source = 'MANUAL',
      channel = 'RETAIL',
      fulfilmentType = 'STORE_PICKUP',
      requestedStoreId = null,
      addressId = null,
      deliveryAddress = null,
      items,
      couponCode = null,
      redeemLoyaltyCredits = 0,
      customerNotes = null,
      internalNotes = null,
      priority = 'NORMAL',
      idempotencyKey = null,
      prepaidPayment = null,
      createdBy = 'SYSTEM',
    } = params;

    // 1. Idempotency Guard: If key provided, check for existing order
    if (idempotencyKey) {
      const existingOrder: any = localDb
        .prepare('SELECT * FROM orders WHERE idempotency_key = ? AND organization_id = ?')
        .get(idempotencyKey, organizationId);

      if (existingOrder) {
        const existingItems = localDb
          .prepare('SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0')
          .all(existingOrder.id);
        return {
          orderId: existingOrder.id,
          orderNumber: existingOrder.order_number,
          order: existingOrder as Order,
          items: existingItems as OrderItem[],
        };
      }
    }

    // 2. Validate Customer
    const customer: any = localDb
      .prepare('SELECT * FROM customers WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(customerId, customerId, organizationId);

    if (!customer) {
      throw new AppError(404, `Customer not found: ${customerId}`, 'CUSTOMER_NOT_FOUND');
    }

    // 3. Resolve & Validate Delivery Address for Home Delivery
    let resolvedAddress: any = null;
    if (fulfilmentType === 'HOME_DELIVERY') {
      if (addressId) {
        resolvedAddress = CustomerAddressService.getAddressById(addressId, organizationId);
      } else if (deliveryAddress) {
        resolvedAddress = CustomerAddressService.saveAddress({
          organizationId,
          customerId,
          recipientName: deliveryAddress.recipient_name,
          phone: deliveryAddress.phone,
          addressLine1: deliveryAddress.address_line_1,
          addressLine2: deliveryAddress.address_line_2,
          locality: deliveryAddress.locality,
          city: deliveryAddress.city,
          state: deliveryAddress.state,
          pincode: deliveryAddress.pincode,
          landmark: deliveryAddress.landmark,
          latitude: deliveryAddress.latitude,
          longitude: deliveryAddress.longitude,
          deliveryInstructions: deliveryAddress.delivery_instructions,
        });
      }

      if (!resolvedAddress) {
        throw new AppError(400, 'Valid delivery address is required for HOME_DELIVERY orders', 'ADDRESS_REQUIRED');
      }
    }

    // 4. Generate Server-Side Authoritative Commercial Quote
    const quote = OrderQuoteService.generateQuote({
      organizationId,
      storeId: requestedStoreId,
      customerId,
      channel,
      fulfilmentType,
      items,
      couponCode,
      redeemLoyaltyCredits,
    });

    // 5. Prescription Safety Verification
    let prescriptionStatus: OrderPrescriptionStatus = 'NOT_REQUIRED';
    if (quote.hasPrescriptionMedication) {
      prescriptionStatus = 'PENDING_REVIEW';

      // Check if any verified prescription is attached for the items
      for (const it of items) {
        const medRow: any = localDb
          .prepare('SELECT name, prescription_required FROM medicines WHERE id = ? OR _local_id = ?')
          .get(it.medicine_id, it.medicine_id);

        if (medRow?.prescription_required) {
          let hasVerifiedRx = false;
          if (it.prescription_id) {
            const rx: any = localDb
              .prepare("SELECT verification_status, status FROM prescriptions WHERE (id = ? OR _local_id = ?) AND _deleted = 0")
              .get(it.prescription_id, it.prescription_id);
            if (rx?.verification_status === 'VERIFIED') {
              hasVerifiedRx = true;
            }
          }

          if (hasVerifiedRx) {
            prescriptionStatus = 'VERIFIED';
          }
        }
      }
    }

    // 6. Select Best Eligible Fulfilment Location
    const selectedLocation = FulfilmentEngine.selectBestLocation({
      organizationId,
      items,
      fulfilmentType,
      requestedStoreId,
      customerCoordinates: resolvedAddress?.latitude && resolvedAddress?.longitude
        ? { latitude: resolvedAddress.latitude, longitude: resolvedAddress.longitude }
        : null,
      pincode: resolvedAddress?.pincode || null,
      requireSingleStoreFulfilment: true,
    });

    const fulfilmentStoreId = selectedLocation.locationId;

    // 7. Atomic Order Creation & Inventory Reservation
    let confirmedOrder: Order | null = null;
    let confirmedItems: OrderItem[] = [];

    const executeConfirmationTx = localDb.transaction(() => {
      const orderId = uuidv4();
      const orderNumber = DocumentNumberingService.generate({
        organizationId,
        storeId: fulfilmentStoreId,
        documentType: 'ORDER',
      });

      const nowIso = new Date().toISOString();

      // Generate pickup code for Click & Collect / Store Pickup
      let pickupCode: string | null = null;
      let pickupCodeHash: string | null = null;
      if (fulfilmentType === 'STORE_PICKUP' || fulfilmentType === 'CLICK_COLLECT') {
        const codeGen = OrderPickupService.generatePickupCode();
        pickupCode = codeGen.code;
        pickupCodeHash = codeGen.hash;
      }

      // Initial Order Status: If prescription needs review, order stays in PRESCRIPTION_PENDING; otherwise CONFIRMED
      const initialStatus: OrderStatus =
        prescriptionStatus === 'PENDING_REVIEW' ? 'PRESCRIPTION_PENDING' : 'CONFIRMED';

      // Insert Order Record
      const orderRecord = localMutate({
        table: 'orders',
        operation: 'INSERT',
        data: {
          id: orderId,
          _local_id: orderId,
          organization_id: organizationId,
          order_number: orderNumber,
          customer_id: customerId,
          patient_id: patientId,
          source,
          channel,
          fulfilment_type: fulfilmentType,
          requested_store_id: requestedStoreId,
          fulfilment_store_id: fulfilmentStoreId,
          status: initialStatus,
          prescription_status: prescriptionStatus,
          payment_status: prepaidPayment ? 'PAID' : 'UNPAID',
          fulfilment_status: 'ASSIGNED',
          priority,
          customer_notes: customerNotes,
          internal_notes: internalNotes,
          subtotal_paise: quote.subtotalPaise,
          subtotal: quote.subtotal,
          discount_total_paise: quote.discountTotalPaise,
          discount_total: quote.discountTotal,
          tax_total_paise: quote.taxTotalPaise,
          tax_total: quote.taxTotal,
          loyalty_redemption_paise: quote.loyaltyRedemptionPaise,
          loyalty_redemption_credits: quote.loyaltyRedemptionCredits,
          delivery_charge_paise: quote.deliveryChargePaise,
          delivery_charge: quote.deliveryCharge,
          round_off_paise: quote.roundOffPaise,
          round_off: quote.roundOff,
          grand_total_paise: quote.grandTotalPaise,
          grand_total: quote.grandTotal,
          pickup_code: pickupCode,
          pickup_code_hash: pickupCodeHash,
          idempotency_key: idempotencyKey,
          quote_expires_at: quote.expiresAt,
          placed_at: nowIso,
          confirmed_at: nowIso,
          created_by: createdBy,
          created_at: nowIso,
          updated_at: nowIso,
        },
      });

      // Insert Address Snapshot if Home Delivery
      if (resolvedAddress) {
        const snapId = uuidv4();
        localMutate({
          table: 'order_address_snapshots',
          operation: 'INSERT',
          data: {
            id: snapId,
            _local_id: snapId,
            order_id: orderId,
            organization_id: organizationId,
            address_id: resolvedAddress.id || null,
            recipient_name: resolvedAddress.recipient_name,
            phone: resolvedAddress.phone,
            address_line_1: resolvedAddress.address_line_1,
            address_line_2: resolvedAddress.address_line_2 || null,
            locality: resolvedAddress.locality || null,
            city: resolvedAddress.city,
            state: resolvedAddress.state,
            state_code: resolvedAddress.state_code || '36',
            pincode: resolvedAddress.pincode,
            landmark: resolvedAddress.landmark || null,
            latitude: resolvedAddress.latitude,
            longitude: resolvedAddress.longitude,
            delivery_instructions: resolvedAddress.delivery_instructions || null,
            created_at: nowIso,
          },
        });
      }

      // Save Commercial Snapshot
      OrderQuoteService.saveCommercialSnapshot(orderId, organizationId, quote);

      // Insert Order Items
      const orderItemsToReserve: Array<{ orderItemId: string; medicineId: string; baseQuantity: number }> = [];

      for (const qLine of quote.commercialQuote.lines) {
        const origItem = items.find(i => i.medicine_id === qLine.medicineId);
        const itemId = uuidv4();
        const itemRecord = localMutate({
          table: 'order_items',
          operation: 'INSERT',
          data: {
            id: itemId,
            _local_id: itemId,
            order_id: orderId,
            organization_id: organizationId,
            medicine_id: qLine.medicineId,
            medicine_name: qLine.medicineName,
            requested_unit: qLine.unitType,
            conversion_factor: qLine.conversionFactor,
            requested_quantity: qLine.requestedQuantity,
            base_quantity: qLine.baseQuantity,
            fulfilled_quantity: 0,
            cancelled_quantity: 0,
            substituted_quantity: 0,
            prescription_required: (origItem as any)?.prescription_required || (origItem as any)?.prescription_id ? 1 : 0,
            prescription_item_id: origItem?.prescription_item_id || null,
            prescription_id: origItem?.prescription_id || null,
            mrp_paise: qLine.mrpPaise,
            unit_price_paise: qLine.effectiveUnitPricePaise || qLine.basePricePaise,
            discount_amount_paise: qLine.totalDiscountPaise || 0,
            taxable_amount_paise: qLine.taxableAmountPaise,
            tax_amount_paise: qLine.taxAmountPaise,
            gst_rate: qLine.gstRate,
            line_total_paise: qLine.lineTotalPaise,
            status: initialStatus === 'PRESCRIPTION_PENDING' ? 'PENDING_PRESCRIPTION' : 'CONFIRMED',
            notes: origItem?.notes || null,
            created_at: nowIso,
            updated_at: nowIso,
          },
        });
        confirmedItems.push(itemRecord);
        orderItemsToReserve.push({
          orderItemId: itemId,
          medicineId: qLine.medicineId,
          baseQuantity: qLine.baseQuantity,
        });
      }

      // Create Fulfilment Group Header
      const fulfilmentId = uuidv4();
      localMutate({
        table: 'order_fulfilments',
        operation: 'INSERT',
        data: {
          id: fulfilmentId,
          _local_id: fulfilmentId,
          order_id: orderId,
          organization_id: organizationId,
          fulfilment_group_number: 1,
          fulfilment_type: fulfilmentType,
          location_type: 'STORE',
          store_id: fulfilmentStoreId,
          status: 'ASSIGNED',
          priority,
          assigned_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        },
      });

      // Lock FEFO Inventory Reservations (unless blocked on prescription review)
      if (prescriptionStatus !== 'PENDING_REVIEW') {
        const allocations = OrderReservationService.reserveOrderStock({
          orderId,
          organizationId,
          storeId: fulfilmentStoreId,
          items: orderItemsToReserve,
          createdBy,
        });

        // Insert Order Fulfilment Items
        for (const alloc of allocations) {
          const fiId = uuidv4();
          localMutate({
            table: 'order_fulfilment_items',
            operation: 'INSERT',
            data: {
              id: fiId,
              _local_id: fiId,
              fulfilment_id: fulfilmentId,
              order_id: orderId,
              order_item_id: alloc.orderItemId,
              organization_id: organizationId,
              medicine_id: alloc.medicineId,
              batch_id: alloc.batchId,
              quantity_allocated: alloc.quantityAllocated,
              quantity_picked: 0,
              quantity_packed: 0,
              reservation_id: alloc.reservationId,
              status: 'RESERVED',
              created_at: nowIso,
              updated_at: nowIso,
            },
          });
        }

        // Update items to RESERVED
        localDb
          .prepare("UPDATE order_items SET status = 'RESERVED', updated_at = ?, _updated_at = ? WHERE order_id = ?")
          .run(nowIso, nowIso, orderId);

        localDb
          .prepare("UPDATE orders SET status = 'INVENTORY_RESERVED', fulfilment_status = 'RESERVED', updated_at = ?, _updated_at = ? WHERE id = ?")
          .run(nowIso, nowIso, orderId);
      }

      // Record Prepaid Payment if provided
      if (prepaidPayment) {
        const pTxId = uuidv4();
        const amtPaise = Math.round(Number(prepaidPayment.amount || quote.grandTotal) * 100);
        localMutate({
          table: 'payment_transactions',
          operation: 'INSERT',
          data: {
            id: pTxId,
            _local_id: pTxId,
            organization_id: organizationId,
            store_id: fulfilmentStoreId,
            order_id: orderId,
            tender_type: (prepaidPayment.tender_type || 'UPI').toUpperCase(),
            amount: Money.toRupees(amtPaise),
            amount_paise: amtPaise,
            currency: 'INR',
            reference_number: prepaidPayment.reference_number || `TXN-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
            provider: prepaidPayment.provider || 'GATEWAY',
            status: 'COMPLETED',
            created_at: nowIso,
          },
        });
      }

      // Log Confirmation Event
      OrderEventService.logEvent({
        orderId,
        fulfilmentId,
        organizationId,
        eventType: 'ORDER_CONFIRMED',
        fromStatus: 'CREATED',
        toStatus: prescriptionStatus === 'PENDING_REVIEW' ? 'PRESCRIPTION_PENDING' : 'CONFIRMED',
        actorId: createdBy,
        details: {
          orderNumber,
          fulfilmentStoreId,
          grandTotal: quote.grandTotal,
          hasPrescription: quote.hasPrescriptionMedication,
          isPrepaid: Boolean(prepaidPayment),
        },
        notes: `Order #${orderNumber} confirmed at ${selectedLocation.locationName}`,
      });

      confirmedOrder = localDb.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    });

    executeConfirmationTx();

    return {
      orderId: confirmedOrder!.id,
      orderNumber: confirmedOrder!.order_number,
      order: confirmedOrder!,
      items: confirmedItems,
    };
  }

  /**
   * Cancel an order and safely release/refund
   */
  static cancelOrder(params: {
    orderId: string;
    organizationId: string;
    reason?: OrderCancellationReason | string;
    cancelledByUserId: string;
  }): { success: boolean; order: Order } {
    const { orderId, organizationId, reason = 'CUSTOMER_REQUEST', cancelledByUserId } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(orderId, orderId, organizationId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    const cancelCheck = OrderStateMachine.canCancelOrder(order.status);
    if (!cancelCheck.allowed) {
      throw new AppError(400, cancelCheck.reason || 'Order cannot be cancelled', 'CANNOT_CANCEL_ORDER');
    }

    const nowIso = new Date().toISOString();

    const cancelTx = localDb.transaction(() => {
      // 1. Release all active inventory reservations
      OrderReservationService.releaseOrderReservations(order.id, organizationId);

      // 2. If prepaid, create refund record
      if (order.payment_status === 'PAID' || order.payment_status === 'PARTIALLY_PAID') {
        const paymentTx: any = localDb
          .prepare("SELECT * FROM payment_transactions WHERE order_id = ? AND status = 'COMPLETED'")
          .get(order.id);

        const refundId = uuidv4();
        localMutate({
          table: 'order_refunds',
          operation: 'INSERT',
          data: {
            id: refundId,
            _local_id: refundId,
            order_id: order.id,
            organization_id: organizationId,
            payment_transaction_id: paymentTx?.id || null,
            amount_paise: order.grand_total_paise || Math.round(order.grand_total * 100),
            amount: order.grand_total,
            reason: `Order cancelled: ${reason}`,
            status: 'PENDING',
            refund_reference: `REF-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
            processed_by: cancelledByUserId,
            processed_at: nowIso,
            created_at: nowIso,
            updated_at: nowIso,
          },
        });

        localDb
          .prepare("UPDATE orders SET payment_status = 'REFUND_PENDING' WHERE id = ?")
          .run(order.id);

        OrderEventService.logEvent({
          orderId: order.id,
          organizationId,
          eventType: 'REFUND_INITIATED',
          actorId: cancelledByUserId,
          details: {
            refundAmount: order.grand_total,
            reason,
          },
          notes: `Refund of ₹${order.grand_total} initiated for cancelled prepaid order`,
        });
      }

      // 3. Mark Order as CANCELLED
      localMutate({
        table: 'orders',
        operation: 'UPDATE',
        data: {
          id: order.id,
          status: 'CANCELLED',
          fulfilment_status: 'CANCELLED',
          cancelled_at: nowIso,
          cancellation_reason: reason,
          updated_at: nowIso,
        },
      });

      localDb
        .prepare("UPDATE order_items SET status = 'CANCELLED', updated_at = ?, _updated_at = ? WHERE order_id = ?")
        .run(nowIso, nowIso, order.id);

      localDb
        .prepare("UPDATE order_fulfilments SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ?, updated_at = ?, _updated_at = ? WHERE order_id = ?")
        .run(nowIso, reason, nowIso, nowIso, order.id);

      OrderEventService.logEvent({
        orderId: order.id,
        organizationId,
        eventType: 'CANCELLED',
        fromStatus: order.status,
        toStatus: 'CANCELLED',
        actorId: cancelledByUserId,
        details: { reason },
        notes: `Order cancelled. Reason: ${reason}`,
      });
    });

    cancelTx();

    const updated = localDb.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    return { success: true, order: updated as any as Order };
  }

  /**
   * Reassign fulfilment store
   */
  static reassignFulfilmentStore(params: {
    orderId: string;
    organizationId: string;
    targetStoreId: string;
    reassignedByUserId: string;
    reason?: string;
  }): { success: boolean; order: Order } {
    const { orderId, organizationId, targetStoreId, reassignedByUserId, reason = 'MANUAL_REASSIGNMENT' } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(orderId, orderId, organizationId);

    if (!order) throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');

    if (order.status === 'COMPLETED' || order.status === 'CANCELLED' || order.status === 'READY_FOR_PICKUP') {
      throw new AppError(400, `Cannot reassign order in status '${order.status}'`, 'CANNOT_REASSIGN_ORDER');
    }

    const targetStore: any = localDb
      .prepare('SELECT * FROM stores WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(targetStoreId, targetStoreId, organizationId);

    if (!targetStore) throw new AppError(404, 'Target store not found', 'STORE_NOT_FOUND');

    const nowIso = new Date().toISOString();

    const reassignTx = localDb.transaction(() => {
      // 1. Release old store reservations
      OrderReservationService.releaseOrderReservations(order.id, organizationId);

      // 2. Clear old fulfilment items
      localDb.prepare('DELETE FROM order_fulfilment_items WHERE order_id = ?').run(order.id);

      // 3. Query items to reserve at new store
      const items: any[] = localDb
        .prepare("SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0 AND status != 'CANCELLED'")
        .all(order.id);

      const itemsToReserve = items.map(it => ({
        orderItemId: it.id,
        medicineId: it.medicine_id,
        baseQuantity: Number(it.base_quantity || it.requested_quantity || 1),
      }));

      // 4. Reserve stock at new store
      const newAllocations = OrderReservationService.reserveOrderStock({
        orderId: order.id,
        organizationId,
        storeId: targetStore.id,
        items: itemsToReserve,
        createdBy: reassignedByUserId,
      });

      // 5. Update fulfilment header and re-insert items
      const fulfilment: any = localDb
        .prepare('SELECT id FROM order_fulfilments WHERE order_id = ?')
        .get(order.id);

      if (fulfilment) {
        localDb
          .prepare('UPDATE order_fulfilments SET store_id = ?, updated_at = ?, _updated_at = ? WHERE id = ?')
          .run(targetStore.id, nowIso, nowIso, fulfilment.id);

        for (const alloc of newAllocations) {
          const fiId = uuidv4();
          localMutate({
            table: 'order_fulfilment_items',
            operation: 'INSERT',
            data: {
              id: fiId,
              _local_id: fiId,
              fulfilment_id: fulfilment.id,
              order_id: order.id,
              order_item_id: alloc.orderItemId,
              organization_id: organizationId,
              medicine_id: alloc.medicineId,
              batch_id: alloc.batchId,
              quantity_allocated: alloc.quantityAllocated,
              quantity_picked: 0,
              quantity_packed: 0,
              reservation_id: alloc.reservationId,
              status: 'RESERVED',
              created_at: nowIso,
              updated_at: nowIso,
            },
          });
        }
      }

      // 6. Update order header
      localMutate({
        table: 'orders',
        operation: 'UPDATE',
        data: {
          id: order.id,
          fulfilment_store_id: targetStore.id,
          updated_at: nowIso,
        },
      });

      OrderEventService.logEvent({
        orderId: order.id,
        organizationId,
        eventType: 'FULFILMENT_REASSIGNED',
        actorId: reassignedByUserId,
        details: {
          previousStoreId: order.fulfilment_store_id,
          newStoreId: targetStore.id,
          newStoreName: targetStore.name,
          reason,
        },
        notes: `Fulfilment reassigned to store ${targetStore.name}. Reason: ${reason}`,
      });
    });

    reassignTx();

    const updated = localDb.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    return { success: true, order: updated as any as Order };
  }
}
