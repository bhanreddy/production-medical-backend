import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  Coupon,
  CouponValidationResult,
  CouponValidationStatus,
} from '../../domain/commercialTypes';

export interface ValidateCouponContext {
  organizationId: string;
  storeId?: string | null;
  customerId?: string | null;
  code: string;
  cartSubtotalPaise: number;
  eligibleMedicineIds?: string[];
  isOffline?: boolean;
  asOfDate?: Date;
}

export class CouponEngine {
  /**
   * Validates a coupon against current cart context and computes discount
   */
  static validateCoupon(context: ValidateCouponContext): CouponValidationResult {
    const {
      organizationId,
      storeId,
      customerId,
      code,
      cartSubtotalPaise,
      eligibleMedicineIds = [],
      isOffline = false,
      asOfDate = new Date(),
    } = context;

    if (!code || !code.trim()) {
      return {
        isValid: false,
        statusCode: 'INVALID',
        message: 'No coupon code provided',
        discountAmountPaise: 0,
      };
    }

    const cleanCode = code.trim().toUpperCase();

    // 1. Fetch Coupon Row
    const couponRow: any = localDb
      .prepare(
        `SELECT * FROM coupons 
         WHERE UPPER(code) = ? 
           AND (organization_id = ?)
           AND _deleted = 0`
      )
      .get(cleanCode, organizationId);

    if (!couponRow || !couponRow.is_active) {
      return {
        isValid: false,
        statusCode: 'INVALID',
        message: `Coupon code '${cleanCode}' is invalid or inactive`,
        discountAmountPaise: 0,
      };
    }

    const coupon: Coupon = {
      ...couponRow,
      eligible_stores: typeof couponRow.eligible_stores === 'string'
        ? JSON.parse(couponRow.eligible_stores || '[]')
        : (couponRow.eligible_stores || []),
      eligible_products: typeof couponRow.eligible_products === 'string'
        ? JSON.parse(couponRow.eligible_products || '[]')
        : (couponRow.eligible_products || []),
    };

    // 2. Offline Risk Policy Check: One-time/sensitive coupons require online validation
    if (isOffline && (coupon.coupon_type === 'ONE_TIME' || coupon.max_uses === 1)) {
      return {
        isValid: false,
        statusCode: 'ONLINE_REQUIRED',
        message: 'One-time coupon requires online server validation to prevent double-spending',
        discountAmountPaise: 0,
        coupon,
      };
    }

    const nowIso = asOfDate.toISOString();

    // 3. Date Validity
    if (coupon.start_at && coupon.start_at > nowIso) {
      return {
        isValid: false,
        statusCode: 'NOT_STARTED',
        message: `Coupon '${cleanCode}' is not active yet (starts on ${new Date(coupon.start_at).toLocaleDateString()})`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    if (coupon.end_at && coupon.end_at < nowIso) {
      return {
        isValid: false,
        statusCode: 'EXPIRED',
        message: `Coupon '${cleanCode}' expired on ${new Date(coupon.end_at).toLocaleDateString()}`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    // 4. Global Usage Limits
    if (coupon.max_uses != null && coupon.current_uses >= coupon.max_uses) {
      return {
        isValid: false,
        statusCode: 'USAGE_LIMIT_REACHED',
        message: `Coupon '${cleanCode}' maximum usage limit has been reached`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    // 5. Customer Specific Assignment
    if (coupon.customer_id && coupon.customer_id !== customerId) {
      return {
        isValid: false,
        statusCode: 'CUSTOMER_NOT_ELIGIBLE',
        message: `Coupon '${cleanCode}' is exclusive to a specific customer`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    // 6. Per-Customer Usage Limit Check
    const maxCustomerUses = Number(coupon.max_uses_per_customer ?? 1);
    if (customerId && maxCustomerUses > 0) {
      const cId = couponRow.id || couponRow._local_id || '';
      const cLocalId = couponRow._local_id || couponRow.id || '';
      const cCode = couponRow.code || cleanCode;
      const redemptionsCountRow: any = localDb
        .prepare(
          `SELECT COUNT(*) as count FROM coupon_redemptions 
           WHERE (coupon_id = ? OR coupon_id = ? OR coupon_id = ? OR coupon_id IN (SELECT id FROM coupons WHERE UPPER(code) = ?) OR coupon_id IN (SELECT _local_id FROM coupons WHERE UPPER(code) = ?)) 
             AND (customer_id = ? OR customer_id = ?) AND _deleted = 0`
        )
        .get(cId, cLocalId, cCode, cleanCode, cleanCode, customerId, customerId);

      const pastUses = Number(redemptionsCountRow?.count || 0);
      if (pastUses >= maxCustomerUses) {
        return {
          isValid: false,
          statusCode: 'CUSTOMER_LIMIT_REACHED',
          message: `You have already used coupon '${cleanCode}' the maximum allowed times (${maxCustomerUses})`,
          discountAmountPaise: 0,
          coupon,
        };
      }
    }

    // 7. Store Scope Eligibility
    const eligibleStores = Array.isArray(coupon.eligible_stores) ? coupon.eligible_stores : [];
    if (eligibleStores.length > 0 && storeId && !eligibleStores.includes(storeId)) {
      return {
        isValid: false,
        statusCode: 'STORE_NOT_ELIGIBLE',
        message: `Coupon '${cleanCode}' is not applicable at this store location`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    // 8. Product Scope Eligibility
    const eligibleProducts = Array.isArray(coupon.eligible_products) ? coupon.eligible_products : [];
    if (eligibleProducts.length > 0) {
      const hasMatchingProduct = eligibleMedicineIds.some(medId => eligibleProducts.includes(medId));
      if (!hasMatchingProduct) {
        return {
          isValid: false,
          statusCode: 'PRODUCT_NOT_ELIGIBLE',
          message: `Coupon '${cleanCode}' requires eligible promotional items in cart`,
          discountAmountPaise: 0,
          coupon,
        };
      }
    }

    // 9. Minimum Cart Value Check
    if (coupon.min_spend_paise > 0 && cartSubtotalPaise < coupon.min_spend_paise) {
      const minSpendRs = Money.toRupees(coupon.min_spend_paise);
      return {
        isValid: false,
        statusCode: 'MINIMUM_CART_NOT_MET',
        message: `Cart subtotal (₹${Money.toRupees(cartSubtotalPaise)}) is below minimum spend requirement (₹${minSpendRs}) for coupon '${cleanCode}'`,
        discountAmountPaise: 0,
        coupon,
      };
    }

    // 10. Calculate Discount Amount
    let discountPaise = 0;
    if (coupon.discount_type === 'FLAT') {
      discountPaise = Money.toPaise(coupon.discount_value);
    } else if (coupon.discount_type === 'PERCENTAGE') {
      discountPaise = Math.round((cartSubtotalPaise * Number(coupon.discount_value)) / 100);
    }

    // Cap with max_discount_paise if defined
    if (coupon.max_discount_paise != null && coupon.max_discount_paise > 0) {
      discountPaise = Math.min(discountPaise, coupon.max_discount_paise);
    }

    // Discount cannot exceed cart subtotal
    discountPaise = Math.min(discountPaise, cartSubtotalPaise);

    return {
      isValid: true,
      statusCode: 'VALID',
      message: `Coupon '${cleanCode}' applied successfully! Savings: ₹${Money.toRupees(discountPaise)}`,
      discountAmountPaise: discountPaise,
      coupon,
    };
  }

  /**
   * Atomically records coupon redemption during checkout
   */
  static redeemCoupon(params: {
    organizationId: string;
    couponId: string;
    customerId?: string | null;
    saleId: string;
    discountAmountPaise: number;
  }) {
    const { organizationId, couponId, customerId = null, saleId, discountAmountPaise } = params;

    // Check if already redeemed for this sale (idempotency)
    const existing: any = localDb
      .prepare('SELECT * FROM coupon_redemptions WHERE sale_id = ? AND _deleted = 0')
      .get(saleId);

    if (existing) {
      return existing;
    }

    const redemptionId = uuidv4();
    const record = localMutate({
      table: 'coupon_redemptions',
      operation: 'INSERT',
      data: {
        id: redemptionId,
        _local_id: redemptionId,
        organization_id: organizationId,
        coupon_id: couponId,
        customer_id: customerId,
        sale_id: saleId,
        discount_amount_paise: discountAmountPaise,
        redeemed_at: new Date().toISOString(),
      },
    });

    // Increment current_uses on coupon
    localDb
      .prepare('UPDATE coupons SET current_uses = current_uses + 1 WHERE id = ? OR _local_id = ?')
      .run(couponId, couponId);

    return record;
  }

  /**
   * Coupon Management CRUD
   */
  static listCoupons(organizationId: string): Coupon[] {
    return localDb
      .prepare(
        `SELECT c.*, 
          (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = c.id OR coupon_id = c._local_id) as total_redemptions
         FROM coupons c
         WHERE (c.organization_id = ?) AND c._deleted = 0
         ORDER BY c.created_at DESC`
      )
      .all(organizationId) as Coupon[];
  }

  static createCoupon(data: Partial<Coupon>): Coupon {
    const id = data.id || uuidv4();
    const created = localMutate({
      table: 'coupons',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: data.organization_id,
        code: (data.code || `PROMO${Date.now().toString().slice(-6)}`).toUpperCase(),
        campaign_name: data.campaign_name || '',
        promotion_id: data.promotion_id || null,
        coupon_type: data.coupon_type || 'PUBLIC',
        customer_id: data.customer_id || null,
        discount_type: data.discount_type || 'FLAT',
        discount_value: data.discount_value ?? 0,
        min_spend_paise: data.min_spend_paise ?? 0,
        max_discount_paise: data.max_discount_paise || null,
        max_uses: data.max_uses || null,
        max_uses_per_customer: data.max_uses_per_customer ?? 1,
        current_uses: 0,
        start_at: data.start_at || null,
        end_at: data.end_at || null,
        status: 'ACTIVE',
        is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
        is_stackable: data.is_stackable !== undefined ? (data.is_stackable ? 1 : 0) : 1,
        eligible_stores: JSON.stringify(data.eligible_stores || []),
        eligible_products: JSON.stringify(data.eligible_products || []),
      },
    });
    return created as Coupon;
  }
}
