// orderQuoteService.ts — Server-Side Commercial Quote Adapter for OMS
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { Money } from '../../lib/money';
import { CommercialEngine } from '../commercial/commercialEngine';
import { CustomerGroupService } from '../commercial/customerGroupService';
import {
  CommercialQuoteResult,
  CommercialQuoteContext,
} from '../../domain/commercialTypes';
import { FulfilmentType } from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export interface OrderQuoteRequest {
  organizationId: string;
  storeId?: string | null;
  customerId?: string | null;
  channel?: string;
  fulfilmentType?: FulfilmentType;
  items: Array<{
    medicine_id: string;
    quantity: number;
    unit_type?: string;
    conversion_factor?: number;
    manual_unit_price?: number;
    discount_pct?: number;
    batch_id?: string | null;
  }>;
  couponCode?: string | null;
  redeemLoyaltyCredits?: number;
  billDiscountPaise?: number;
  deliveryChargePaiseOverride?: number | null;
}

export interface OrderQuoteResponse {
  quoteId: string;
  commercialQuote: CommercialQuoteResult;
  deliveryChargePaise: number;
  deliveryCharge: number;
  subtotalPaise: number;
  subtotal: number;
  discountTotalPaise: number;
  discountTotal: number;
  taxTotalPaise: number;
  taxTotal: number;
  loyaltyRedemptionPaise: number;
  loyaltyRedemptionCredits: number;
  roundOffPaise: number;
  roundOff: number;
  grandTotalPaise: number;
  grandTotal: number;
  expiresAt: string;
  hasPrescriptionMedication: boolean;
}

export class OrderQuoteService {
  /** Default quote validity in minutes (30 mins) */
  static readonly DEFAULT_QUOTE_VALIDITY_MINUTES = 30;

  /** Standard Delivery Charge in Paise (₹50.00 = 5000 Paise) */
  static readonly STANDARD_DELIVERY_FEE_PAISE = 5000;

  /** Free Delivery Threshold in Paise (₹500.00 = 50000 Paise) */
  static readonly FREE_DELIVERY_THRESHOLD_PAISE = 50000;

  /**
   * Calculate delivery fee based on fulfilment type, cart total, and membership
   */
  static calculateDeliveryCharge(params: {
    organizationId: string;
    customerId?: string | null;
    fulfilmentType: FulfilmentType;
    cartSubtotalPaise: number;
    overrideFeePaise?: number | null;
  }): number {
    const { organizationId, customerId, fulfilmentType, cartSubtotalPaise, overrideFeePaise } = params;

    if (fulfilmentType !== 'HOME_DELIVERY') {
      return 0;
    }

    if (overrideFeePaise != null && overrideFeePaise >= 0) {
      return overrideFeePaise;
    }

    // Check if customer has Premium or VIP membership with free delivery benefit
    if (customerId) {
      const membership = CustomerGroupService.getActiveMembership(customerId, organizationId);
      if (membership && (membership.membership_type === 'PREMIUM' || membership.tier === 'PLATINUM')) {
        return 0;
      }
    }

    // Free delivery above threshold
    if (cartSubtotalPaise >= this.FREE_DELIVERY_THRESHOLD_PAISE) {
      return 0;
    }

    return this.STANDARD_DELIVERY_FEE_PAISE;
  }

  /**
   * Generate authoritative server-side order quote using Task 3 Commercial Engine
   */
  static generateQuote(request: OrderQuoteRequest): OrderQuoteResponse {
    const {
      organizationId,
      storeId = null,
      customerId = null,
      channel = 'RETAIL',
      fulfilmentType = 'STORE_PICKUP',
      items,
      couponCode = null,
      redeemLoyaltyCredits = 0,
      billDiscountPaise = 0,
      deliveryChargePaiseOverride = null,
    } = request;

    if (!items || items.length === 0) {
      throw new AppError(400, 'Order quote requires at least one item', 'EMPTY_ORDER_CART');
    }

    // Delegate product & pricing math to Commercial Engine
    const commercialQuote = CommercialEngine.quoteCommercialCart({
      organizationId,
      storeId,
      customerId,
      items,
      couponCode,
      redeemLoyaltyCredits,
      billDiscountPaise,
    });

    // Compute Delivery Charge
    const deliveryChargePaise = this.calculateDeliveryCharge({
      organizationId,
      customerId,
      fulfilmentType,
      cartSubtotalPaise: commercialQuote.subtotalPaise,
      overrideFeePaise: deliveryChargePaiseOverride,
    });
    const deliveryCharge = Money.toRupees(deliveryChargePaise);

    // Recompute final totals including delivery charge
    const rawTotalPaise = commercialQuote.grandTotalPaise + deliveryChargePaise;
    const roundedTotalPaise = Math.round(rawTotalPaise);
    const roundOffPaise = roundedTotalPaise - rawTotalPaise;
    const roundOff = Money.toRupees(roundOffPaise);
    const grandTotalPaise = roundedTotalPaise;
    const grandTotal = Money.toRupees(grandTotalPaise);

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.DEFAULT_QUOTE_VALIDITY_MINUTES * 60 * 1000
    ).toISOString();

    const quoteId = uuidv4();

    // Determine if any item requires prescription
    let hasPrescriptionMedication = false;
    for (const it of items) {
      const med: any = localDb.prepare('SELECT prescription_required FROM medicines WHERE id = ? OR _local_id = ?').get(it.medicine_id, it.medicine_id);
      if (med?.prescription_required) {
        hasPrescriptionMedication = true;
        break;
      }
    }

    return {
      quoteId,
      commercialQuote,
      deliveryChargePaise,
      deliveryCharge,
      subtotalPaise: commercialQuote.subtotalPaise,
      subtotal: commercialQuote.subtotal,
      discountTotalPaise: commercialQuote.totalDiscountPaise,
      discountTotal: commercialQuote.totalDiscount,
      taxTotalPaise: commercialQuote.totalGstPaise,
      taxTotal: commercialQuote.totalGst,
      loyaltyRedemptionPaise: commercialQuote.loyaltyRedeemedPaise,
      loyaltyRedemptionCredits: redeemLoyaltyCredits || 0,
      roundOffPaise,
      roundOff,
      grandTotalPaise,
      grandTotal,
      expiresAt,
      hasPrescriptionMedication,
    };
  }

  /**
   * Check if a quote is expired
   */
  static isQuoteExpired(expiresAt: string): boolean {
    return new Date(expiresAt) < new Date();
  }

  /**
   * Store immutable commercial snapshot on order confirmation
   */
  static saveCommercialSnapshot(orderId: string, organizationId: string, quote: OrderQuoteResponse): string {
    const snapshotId = uuidv4();
    const nowIso = new Date().toISOString();

    localMutate({
      table: 'order_commercial_snapshots',
      operation: 'INSERT',
      data: {
        id: snapshotId,
        _local_id: snapshotId,
        order_id: orderId,
        organization_id: organizationId,
        pricing_version: 'V1',
        quote_json: JSON.stringify(quote),
        created_at: nowIso,
      },
    });

    return snapshotId;
  }

  /**
   * Retrieve snapshot for order
   */
  static getCommercialSnapshot(orderId: string, organizationId: string): OrderQuoteResponse | null {
    const row: any = localDb
      .prepare('SELECT quote_json FROM order_commercial_snapshots WHERE order_id = ? AND organization_id = ?')
      .get(orderId, organizationId);

    if (!row || !row.quote_json) return null;
    return JSON.parse(row.quote_json);
  }
}
