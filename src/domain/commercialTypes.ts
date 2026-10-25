export type PriceBookScopeType = 'ORGANIZATION' | 'REGION' | 'STORE' | 'CUSTOMER_GROUP' | 'CHANNEL';
export type PriceBookStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'EXPIRED';

export interface PriceBook {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description?: string | null;
  currency: string;
  priority: number;
  status: PriceBookStatus;
  scope: PriceBookScopeType;
  is_default: boolean | number;
  start_at?: string | null;
  end_at?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface PriceBookItem {
  id: string;
  organization_id: string;
  price_book_id: string;
  medicine_id: string;
  batch_id?: string | null;
  unit_type: string;
  mrp_paise: number;
  selling_price_paise: number;
  min_price_paise: number;
  max_discount_pct: number;
  start_at?: string | null;
  end_at?: string | null;
  is_active: boolean | number;
  _local_id?: string;
}

export interface PriceBookScope {
  id: string;
  organization_id: string;
  price_book_id: string;
  scope_type: PriceBookScopeType;
  scope_id: string;
  _local_id?: string;
}

export interface CustomerGroup {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description?: string | null;
  priority: number;
  default_price_book_id?: string | null;
  discount_pct: number;
  is_active: boolean | number;
  _local_id?: string;
}

export interface CustomerGroupMember {
  id: string;
  organization_id: string;
  customer_group_id: string;
  customer_id: string;
  start_at?: string | null;
  end_at?: string | null;
  status: string;
  _local_id?: string;
}

export interface CustomerMembership {
  id: string;
  organization_id: string;
  customer_id: string;
  membership_number?: string | null;
  membership_type: 'STANDARD' | 'PREMIUM' | 'CORPORATE' | 'SENIOR' | string;
  tier: 'SILVER' | 'GOLD' | 'PLATINUM' | string;
  loyalty_multiplier: number;
  start_at: string;
  end_at?: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED';
  _local_id?: string;
}

export type PromotionType =
  | 'PERCENTAGE_DISCOUNT'
  | 'FLAT_DISCOUNT'
  | 'FIXED_PRICE'
  | 'BUY_X_GET_Y'
  | 'QUANTITY_SLAB'
  | 'BUNDLE'
  | 'CATEGORY_DISCOUNT'
  | 'BRAND_DISCOUNT'
  | 'MANUFACTURER_DISCOUNT'
  | 'CUSTOMER_GROUP_DISCOUNT'
  | 'CART_THRESHOLD_DISCOUNT'
  | 'COUPON_PROMOTION';

export type PromotionStackability = 'EXCLUSIVE' | 'STACKABLE' | 'BEST_CUSTOMER_PRICE';
export type PromotionStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'CANCELLED';

export interface PromotionConfig {
  percentage_discount?: number;
  flat_discount_paise?: number;
  fixed_price_paise?: number;
  buy_qty?: number;
  get_free_qty?: number;
  reward_medicine_id?: string;
  slabs?: Array<{ min_qty: number; max_qty?: number; price_paise: number; discount_pct?: number }>;
  slab_mode?: 'WHOLE_LINE' | 'INCREMENTAL';
  bundle_price_paise?: number;
  bundle_items?: Array<{ medicine_id: string; quantity: number }>;
  threshold_amount_paise?: number;
  threshold_discount_type?: 'FLAT' | 'PERCENTAGE';
  threshold_discount_value?: number;
  offline_allowed?: boolean;
}

export interface Promotion {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description?: string | null;
  promotion_type: PromotionType;
  priority: number;
  stackability: PromotionStackability;
  start_at?: string | null;
  end_at?: string | null;
  status: PromotionStatus;
  usage_limit?: number | null;
  per_customer_limit?: number | null;
  current_uses: number;
  channel_scope: 'ALL' | 'POS' | 'ONLINE' | 'MOBILE';
  min_cart_value_paise: number;
  max_discount_paise?: number | null;
  is_best_offer_eligible: boolean | number;
  rule_version: number;
  config_json: string | PromotionConfig;
  _local_id?: string;
}

export interface PromotionTarget {
  id: string;
  organization_id: string;
  promotion_id: string;
  target_type: 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'MANUFACTURER' | 'STORE' | 'REGION' | 'CUSTOMER_GROUP';
  target_id: string;
  is_excluded: boolean | number;
  _local_id?: string;
}

export interface PromotionApplication {
  id: string;
  organization_id: string;
  store_id?: string | null;
  sale_id: string;
  promotion_id: string;
  promotion_code: string;
  promotion_name: string;
  discount_amount_paise: number;
  free_quantity: number;
  reward_medicine_id?: string | null;
  _local_id?: string;
}

export type CouponType = 'PUBLIC' | 'CUSTOMER_SPECIFIC' | 'ONE_TIME' | 'CAMPAIGN' | 'PROMO_CODE';

export interface Coupon {
  id: string;
  organization_id: string;
  code: string;
  campaign_name?: string | null;
  promotion_id?: string | null;
  coupon_type: CouponType;
  customer_id?: string | null;
  discount_type: 'FLAT' | 'PERCENTAGE';
  discount_value: number;
  min_spend_paise: number;
  max_discount_paise?: number | null;
  max_uses?: number | null;
  max_uses_per_customer: number;
  current_uses: number;
  start_at?: string | null;
  end_at?: string | null;
  status: string;
  is_active: boolean | number;
  is_stackable: boolean | number;
  eligible_stores: string | string[];
  eligible_products: string | string[];
  _local_id?: string;
}

export type CouponValidationStatus =
  | 'VALID'
  | 'INVALID'
  | 'EXPIRED'
  | 'NOT_STARTED'
  | 'USAGE_LIMIT_REACHED'
  | 'CUSTOMER_LIMIT_REACHED'
  | 'MINIMUM_CART_NOT_MET'
  | 'STORE_NOT_ELIGIBLE'
  | 'PRODUCT_NOT_ELIGIBLE'
  | 'CUSTOMER_NOT_ELIGIBLE'
  | 'NOT_STACKABLE'
  | 'ONLINE_REQUIRED';

export interface CouponValidationResult {
  isValid: boolean;
  statusCode: CouponValidationStatus;
  message: string;
  discountAmountPaise: number;
  coupon?: Coupon | null;
}

export interface LoyaltyProgram {
  id: string;
  organization_id: string;
  name: string;
  earn_rate_spend_paise: number;
  credits_per_earn_unit: number;
  redemption_rate_paise_per_credit: number;
  min_redemption_credits: number;
  max_redemption_pct: number;
  credit_expiry_days: number;
  exclude_taxes_from_earn: boolean | number;
  exclude_discounted_items: boolean | number;
  status: string;
  is_active: boolean | number;
  _local_id?: string;
}

export interface LoyaltyAccount {
  id: string;
  organization_id: string;
  customer_id: string;
  program_id: string;
  available_balance: number;
  pending_balance: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  status: string;
  _local_id?: string;
}

export type LoyaltyTransactionType = 'EARN' | 'REDEEM' | 'REVERSAL' | 'ADJUSTMENT' | 'EXPIRY' | 'BONUS';

export interface LoyaltyTransaction {
  id: string;
  organization_id: string;
  account_id: string;
  customer_id: string;
  sale_id?: string | null;
  return_id?: string | null;
  transaction_type: LoyaltyTransactionType;
  credits: number;
  credits_balance_after: number;
  monetary_value_paise: number;
  notes?: string | null;
  idempotency_key?: string | null;
  created_at?: string;
  _local_id?: string;
}

export type SupplierSchemeType = 'BUY_X_GET_Y_FREE' | 'TRADE_DISCOUNT_PCT' | 'FLAT_DISCOUNT' | 'SCHEME_CREDIT';

export interface SupplierScheme {
  id: string;
  organization_id: string;
  supplier_id?: string | null;
  name: string;
  scheme_type: SupplierSchemeType;
  medicine_id?: string | null;
  category_id?: string | null;
  manufacturer?: string | null;
  min_quantity: number;
  free_quantity: number;
  discount_pct: number;
  flat_discount_paise: number;
  scheme_credit_paise: number;
  start_at?: string | null;
  end_at?: string | null;
  status: string;
  priority: number;
  config_json?: string | Record<string, any>;
  _local_id?: string;
}

export interface MarginGuardResult {
  costPaise: number;
  costSource: 'BATCH_COST' | 'SUPPLIER_SCHEME_EFFECTIVE_COST' | 'DEFAULT_COST';
  sellingPricePaise: number;
  grossMarginPaise: number;
  grossMarginPct: number;
  status: 'ALLOWED' | 'WARNING' | 'SUPERVISOR_APPROVAL_REQUIRED' | 'MANAGER_APPROVAL_REQUIRED' | 'BLOCKED';
  warningMessage?: string;
  requiresSupervisorApproval: boolean;
  approvalReason?: string;
}

export interface ResolvedPriceHierarchy {
  mrpPaise: number;
  basePricePaise: number;
  minAllowedPricePaise: number;
  maxDiscountPct: number;
  source: 'STORE_PRICE_BOOK' | 'REGION_PRICE_BOOK' | 'ORG_PRICE_BOOK' | 'CUSTOMER_GROUP_PRICE_BOOK' | 'MASTER_CATALOG';
  sourceId?: string;
  sourceName?: string;
  priority: number;
}

export interface CommercialLineInput {
  medicine_id: string;
  batch_id?: string | null;
  quantity: number;
  unit_type?: string;
  conversion_factor?: number;
  requested_discount_pct?: number;
  manual_unit_price?: number;
}

export interface CommercialLineCalculation {
  medicineId: string;
  medicineName: string;
  unitType: string;
  conversionFactor: number;
  requestedQuantity: number;
  baseQuantity: number;
  mrpPaise: number;
  mrp: number;
  basePricePaise: number;
  basePrice: number;
  priceSource: string;
  priceSourceName?: string;
  appliedPromotionId?: string;
  appliedPromotionCode?: string;
  appliedPromotionName?: string;
  promotionDiscountPaise: number;
  membershipDiscountPaise: number;
  manualDiscountPaise: number;
  totalDiscountPaise: number;
  freeQuantity: number;
  rewardMedicineId?: string;
  effectiveUnitPricePaise: number;
  effectiveUnitPrice: number;
  taxableAmountPaise: number;
  taxableAmount: number;
  gstRate: number;
  taxAmountPaise: number;
  taxAmount: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  lineTotalPaise: number;
  lineTotal: number;
  savingsPaise: number;
  margin: MarginGuardResult;
  warnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }>;
  requiresSupervisorApproval: boolean;
  approvalReasons: string[];
}

export interface CommercialQuoteContext {
  organizationId: string;
  storeId?: string | null;
  counterId?: string | null;
  terminalId?: string | null;
  customerId?: string | null;
  items: CommercialLineInput[];
  couponCode?: string | null;
  redeemLoyaltyCredits?: number;
  billDiscountPaise?: number;
  paidAmount?: number;
  isInterstate?: boolean;
  isOffline?: boolean;
}

export interface CommercialQuoteResult {
  lines: CommercialLineCalculation[];
  mrpTotalPaise: number;
  mrpTotal: number;
  basePriceTotalPaise: number;
  basePriceTotal: number;
  subtotalPaise: number;
  subtotal: number;
  promotionDiscountPaise: number;
  promotionDiscount: number;
  membershipDiscountPaise: number;
  membershipDiscount: number;
  couponDiscountPaise: number;
  couponDiscount: number;
  manualDiscountPaise: number;
  manualDiscount: number;
  totalDiscountPaise: number;
  totalDiscount: number;
  loyaltyRedeemedPaise: number;
  loyaltyRedeemed: number;
  loyaltyCreditsRedeemed: number;
  loyaltyCreditsEarnable: number;
  availableLoyaltyCredits: number;
  availableLoyaltyValuePaise: number;
  customerMembership?: CustomerMembership | null;
  customerGroupName?: string | null;
  taxableAmountPaise: number;
  taxableAmount: number;
  totalGstPaise: number;
  totalGst: number;
  cgstPaise: number;
  cgst: number;
  sgstPaise: number;
  sgst: number;
  igstPaise: number;
  igst: number;
  roundOffPaise: number;
  roundOff: number;
  grandTotalPaise: number;
  grandTotal: number;
  totalSavingsPaise: number;
  totalSavings: number;
  overallGrossMarginPaise: number;
  overallGrossMarginPct: number;
  appliedPromotions: Array<{ id: string; code: string; name: string; discountPaise: number; freeQty: number }>;
  rejectedPromotions: Array<{ id: string; code: string; name: string; reason: string }>;
  couponValidation?: CouponValidationResult | null;
  warnings: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'BLOCKING' }>;
  requiresSupervisorApproval: boolean;
  approvalReasons: string[];
}
