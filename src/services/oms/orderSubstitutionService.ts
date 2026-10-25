// orderSubstitutionService.ts — Controlled Medicine & OTC Substitution Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { OrderEventService } from './orderEventService';
import { OrderQuoteService } from './orderQuoteService';
import { OrderSubstitution } from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export interface SubstitutionRequestParams {
  orderId: string;
  orderItemId: string;
  organizationId: string;
  suggestedMedicineId: string;
  reason: string;
  requestedByUserId: string;
}

export class OrderSubstitutionService {
  /**
   * Request a product substitution for an order item
   */
  static requestSubstitution(params: SubstitutionRequestParams): OrderSubstitution {
    const {
      orderId,
      orderItemId,
      organizationId,
      suggestedMedicineId,
      reason,
      requestedByUserId,
    } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?')
      .get(orderId, organizationId);
    if (!order) throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');

    const item: any = localDb
      .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
      .get(orderItemId, orderId);
    if (!item) throw new AppError(404, 'Order item not found', 'ITEM_NOT_FOUND');

    const origMed: any = localDb
      .prepare('SELECT * FROM medicines WHERE id = ? OR _local_id = ?')
      .get(item.medicine_id, item.medicine_id);
    const suggMed: any = localDb
      .prepare('SELECT * FROM medicines WHERE id = ? OR _local_id = ?')
      .get(suggestedMedicineId, suggestedMedicineId);

    if (!suggMed) {
      throw new AppError(404, 'Suggested substitute medicine not found', 'MEDICINE_NOT_FOUND');
    }

    // Prescription Rule: If prescribed drug, professional pharmacist review is strictly mandatory
    const isRxRequired = Boolean(origMed?.prescription_required || item.prescription_required || suggMed.prescription_required);

    const origPricePaise = Number(item.unit_price_paise || 0);
    const suggPricePaise = Math.round(Number(suggMed.mrp || 0) * 100);
    const priceDiffPaise = (suggPricePaise - origPricePaise) * Number(item.requested_quantity || 1);

    const substitutionId = uuidv4();
    const nowIso = new Date().toISOString();

    localMutate({
      table: 'order_substitutions',
      operation: 'INSERT',
      data: {
        id: substitutionId,
        _local_id: substitutionId,
        order_id: orderId,
        order_item_id: orderItemId,
        organization_id: organizationId,
        original_medicine_id: item.medicine_id,
        original_medicine_name: item.medicine_name,
        suggested_medicine_id: suggestedMedicineId,
        suggested_medicine_name: suggMed.name,
        original_unit_price_paise: origPricePaise,
        suggested_unit_price_paise: suggPricePaise,
        price_difference_paise: priceDiffPaise,
        quantity: Number(item.requested_quantity || 1),
        reason,
        requested_by: requestedByUserId,
        customer_confirmed: 0,
        pharmacist_verified: 0,
        status: 'PENDING',
        notes: isRxRequired ? 'MANDATORY_PHARMACIST_VERIFICATION_REQUIRED' : 'OTC_SUBSTITUTION',
        created_at: nowIso,
        updated_at: nowIso,
      },
    });

    localDb
      .prepare(
        `UPDATE order_items 
         SET status = 'SUBSTITUTION_REQUIRED', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso, nowIso, orderItemId);

    OrderEventService.logEvent({
      orderId,
      organizationId,
      eventType: 'SUBSTITUTION_REQUESTED',
      actorId: requestedByUserId,
      details: {
        orderItemId,
        originalMedicine: item.medicine_name,
        suggestedMedicine: suggMed.name,
        priceDifferencePaise: priceDiffPaise,
        isRxRequired,
      },
      notes: `Substitution suggested: ${item.medicine_name} -> ${suggMed.name}`,
    });

    return {
      id: substitutionId,
      order_id: orderId,
      order_item_id: orderItemId,
      organization_id: organizationId,
      original_medicine_id: item.medicine_id,
      original_medicine_name: item.medicine_name,
      suggested_medicine_id: suggestedMedicineId,
      suggested_medicine_name: suggMed.name,
      original_unit_price_paise: origPricePaise,
      suggested_unit_price_paise: suggPricePaise,
      price_difference_paise: priceDiffPaise,
      quantity: Number(item.requested_quantity || 1),
      reason,
      requested_by: requestedByUserId,
      customer_confirmed: false,
      pharmacist_verified: false,
      status: 'PENDING',
      notes: isRxRequired ? 'MANDATORY_PHARMACIST_VERIFICATION_REQUIRED' : 'OTC_SUBSTITUTION',
      created_at: nowIso,
    };
  }

  /**
   * Approve and apply substitution
   */
  static approveSubstitution(params: {
    substitutionId: string;
    organizationId: string;
    approvedByUserId: string;
    approvedByRole: string;
    customerConfirmed?: boolean;
  }): { success: boolean; updatedOrder: any } {
    const { substitutionId, organizationId, approvedByUserId, approvedByRole, customerConfirmed = true } = params;

    const sub: any = localDb
      .prepare('SELECT * FROM order_substitutions WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(substitutionId, substitutionId, organizationId);

    if (!sub) throw new AppError(404, 'Substitution record not found', 'SUBSTITUTION_NOT_FOUND');

    const item: any = localDb
      .prepare('SELECT * FROM order_items WHERE id = ?')
      .get(sub.order_item_id);

    const isRxRequired = sub.notes?.includes('PHARMACIST_VERIFICATION');
    if (isRxRequired && approvedByRole !== 'PHARMACIST' && approvedByRole !== 'STORE_MANAGER' && approvedByRole !== 'OWNER') {
      throw new AppError(
        403,
        'Prescription drug substitution requires approval by a licensed Pharmacist or Store Manager',
        'PHARMACIST_ROLE_REQUIRED'
      );
    }

    const nowIso = new Date().toISOString();

    // 1. Update substitution record
    localMutate({
      table: 'order_substitutions',
      operation: 'UPDATE',
      data: {
        id: sub.id,
        customer_confirmed: customerConfirmed ? 1 : 0,
        customer_confirmed_at: nowIso,
        pharmacist_verified: isRxRequired ? 1 : 0,
        pharmacist_verified_by: isRxRequired ? approvedByUserId : null,
        pharmacist_verified_at: isRxRequired ? nowIso : null,
        status: 'APPLIED',
        updated_at: nowIso,
      },
    });

    // 2. Update order item to substitute medicine and new price
    const newUnitPricePaise = sub.suggested_unit_price_paise;
    const newLineTotalPaise = newUnitPricePaise * Number(item.requested_quantity || 1);

    localDb
      .prepare(
        `UPDATE order_items 
         SET medicine_id = ?, medicine_name = ?, unit_price_paise = ?, line_total_paise = ?,
             substituted_quantity = requested_quantity, status = 'CONFIRMED', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(
        sub.suggested_medicine_id,
        sub.suggested_medicine_name,
        newUnitPricePaise,
        newLineTotalPaise,
        nowIso,
        nowIso,
        item.id
      );

    // 3. Recalculate order commercial quote
    const allItems: any[] = localDb
      .prepare('SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0')
      .all(sub.order_id);

    const quoteInput = allItems.map(it => ({
      medicine_id: it.medicine_id,
      quantity: Number(it.requested_quantity),
      unit_type: it.requested_unit,
      conversion_factor: Number(it.conversion_factor || 1.0),
    }));

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(sub.order_id);

    const recomputedQuote = OrderQuoteService.generateQuote({
      organizationId,
      storeId: order.fulfilment_store_id || order.requested_store_id,
      customerId: order.customer_id,
      channel: order.channel,
      fulfilmentType: order.fulfilment_type,
      items: quoteInput,
      redeemLoyaltyCredits: Number(order.loyalty_redemption_credits || 0),
    });

    // Update order totals
    localMutate({
      table: 'orders',
      operation: 'UPDATE',
      data: {
        id: order.id,
        subtotal_paise: recomputedQuote.subtotalPaise,
        subtotal: recomputedQuote.subtotal,
        discount_total_paise: recomputedQuote.discountTotalPaise,
        discount_total: recomputedQuote.discountTotal,
        tax_total_paise: recomputedQuote.taxTotalPaise,
        tax_total: recomputedQuote.taxTotal,
        grand_total_paise: recomputedQuote.grandTotalPaise,
        grand_total: recomputedQuote.grandTotal,
        updated_at: nowIso,
      },
    });

    OrderEventService.logEvent({
      orderId: order.id,
      organizationId,
      eventType: 'SUBSTITUTION_APPROVED',
      actorId: approvedByUserId,
      details: {
        substitutionId: sub.id,
        substitutedItem: sub.suggested_medicine_name,
        newGrandTotal: recomputedQuote.grandTotal,
      },
      notes: `Substitution applied: ${sub.original_medicine_name} replaced with ${sub.suggested_medicine_name}`,
    });

    const updatedOrder = localDb.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    return { success: true, updatedOrder };
  }
}
