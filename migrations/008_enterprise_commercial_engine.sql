-- ============================================================================
-- Migration 008: Enterprise Commercial Engine
-- Price Books, Promotions, Coupons, Customer Groups, Loyalty Ledger, 
-- Supplier Schemes, Commercial Snapshots & Promotion Applications
-- ============================================================================

-- 1. Price Books (Hierarchical Pricing Master)
CREATE TABLE IF NOT EXISTS price_books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    priority INTEGER NOT NULL DEFAULT 10,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- DRAFT, ACTIVE, INACTIVE, EXPIRED
    scope VARCHAR(32) NOT NULL DEFAULT 'ORGANIZATION', -- ORGANIZATION, REGION, STORE, CUSTOMER_GROUP, CHANNEL
    is_default BOOLEAN NOT NULL DEFAULT false,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_price_books_org_status ON price_books (organization_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_price_books_dates ON price_books (start_at, end_at);

-- 2. Price Book Scopes (Scope Mapping)
CREATE TABLE IF NOT EXISTS price_book_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    price_book_id UUID NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
    scope_type VARCHAR(32) NOT NULL, -- ORGANIZATION, REGION, STORE, CUSTOMER_GROUP, CHANNEL
    scope_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pb_scopes_lookup ON price_book_scopes (organization_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_pb_scopes_pb ON price_book_scopes (price_book_id);

-- 3. Price Book Items (Medicine Pricing Matrix)
CREATE TABLE IF NOT EXISTS price_book_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    price_book_id UUID NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    unit_type VARCHAR(32) NOT NULL DEFAULT 'STRIP',
    mrp_paise BIGINT NOT NULL,
    selling_price_paise BIGINT NOT NULL,
    min_price_paise BIGINT NOT NULL DEFAULT 0,
    max_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 100.0,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pb_items_lookup ON price_book_items (price_book_id, medicine_id, is_active);
CREATE INDEX IF NOT EXISTS idx_pb_items_med ON price_book_items (organization_id, medicine_id);

-- 4. Customer Groups & Memberships
CREATE TABLE IF NOT EXISTS customer_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    priority INTEGER NOT NULL DEFAULT 10,
    default_price_book_id UUID REFERENCES price_books(id) ON DELETE SET NULL,
    discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_customer_groups_org ON customer_groups (organization_id, is_active, priority DESC);

CREATE TABLE IF NOT EXISTS customer_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_group_id UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    assigned_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cgm_cust ON customer_group_members (customer_id, status);
CREATE INDEX IF NOT EXISTS idx_cgm_group ON customer_group_members (customer_group_id);

CREATE TABLE IF NOT EXISTS customer_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    membership_number VARCHAR(64),
    membership_type VARCHAR(64) NOT NULL DEFAULT 'STANDARD', -- STANDARD, PREMIUM, CORPORATE, SENIOR
    tier VARCHAR(32) NOT NULL DEFAULT 'SILVER', -- SILVER, GOLD, PLATINUM
    loyalty_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, EXPIRED, SUSPENDED, CANCELLED
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memberships_cust ON customer_memberships (customer_id, status);

-- 5. Promotions (Structured Promotional Rule Engine)
CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    promotion_type VARCHAR(64) NOT NULL, 
    -- PERCENTAGE_DISCOUNT, FLAT_DISCOUNT, FIXED_PRICE, BUY_X_GET_Y, QUANTITY_SLAB, BUNDLE,
    -- CATEGORY_DISCOUNT, BRAND_DISCOUNT, MANUFACTURER_DISCOUNT, CUSTOMER_GROUP_DISCOUNT, CART_THRESHOLD_DISCOUNT, COUPON_PROMOTION
    priority INTEGER NOT NULL DEFAULT 10,
    stackability VARCHAR(32) NOT NULL DEFAULT 'STACKABLE', -- EXCLUSIVE, STACKABLE, BEST_CUSTOMER_PRICE
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- DRAFT, SCHEDULED, ACTIVE, PAUSED, EXPIRED, CANCELLED
    usage_limit INTEGER,
    per_customer_limit INTEGER,
    current_uses INTEGER NOT NULL DEFAULT 0,
    channel_scope VARCHAR(32) NOT NULL DEFAULT 'ALL', -- ALL, POS, ONLINE, MOBILE
    min_cart_value_paise BIGINT NOT NULL DEFAULT 0,
    max_discount_paise BIGINT,
    is_best_offer_eligible BOOLEAN NOT NULL DEFAULT true,
    rule_version INTEGER NOT NULL DEFAULT 1,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID,
    approved_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_promotions_org_status ON promotions (organization_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions (start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_promotions_type ON promotions (promotion_type);

CREATE TABLE IF NOT EXISTS promotion_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    target_type VARCHAR(32) NOT NULL, -- PRODUCT, CATEGORY, BRAND, MANUFACTURER, STORE, REGION, CUSTOMER_GROUP
    target_id VARCHAR(64) NOT NULL,
    is_excluded BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_targets_lookup ON promotion_targets (promotion_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS promotion_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    reward_type VARCHAR(32) NOT NULL, -- DISCOUNT_PCT, DISCOUNT_AMOUNT, FIXED_PRICE, FREE_ITEM
    reward_value NUMERIC(15,2) NOT NULL DEFAULT 0,
    reward_medicine_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
    reward_quantity NUMERIC(10,2) NOT NULL DEFAULT 0,
    max_reward_value_paise BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_rewards_promo ON promotion_rewards (promotion_id);

CREATE TABLE IF NOT EXISTS promotion_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
    promotion_code VARCHAR(64) NOT NULL,
    promotion_name VARCHAR(255) NOT NULL,
    discount_amount_paise BIGINT NOT NULL DEFAULT 0,
    free_quantity NUMERIC(10,2) NOT NULL DEFAULT 0,
    reward_medicine_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_apps_sale ON promotion_applications (sale_id);
CREATE INDEX IF NOT EXISTS idx_promo_apps_promo ON promotion_applications (promotion_id, created_at);

-- 6. Coupons & Redemptions
CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL,
    campaign_name VARCHAR(255),
    promotion_id UUID REFERENCES promotions(id) ON DELETE SET NULL,
    coupon_type VARCHAR(32) NOT NULL DEFAULT 'PUBLIC', -- PUBLIC, CUSTOMER_SPECIFIC, ONE_TIME, CAMPAIGN, PROMO_CODE
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    discount_type VARCHAR(32) NOT NULL DEFAULT 'FLAT', -- FLAT, PERCENTAGE
    discount_value NUMERIC(15,2) NOT NULL DEFAULT 0,
    min_spend_paise BIGINT NOT NULL DEFAULT 0,
    max_discount_paise BIGINT,
    max_uses INTEGER,
    max_uses_per_customer INTEGER NOT NULL DEFAULT 1,
    current_uses INTEGER NOT NULL DEFAULT 0,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, EXPIRED, DEPLETED, SUSPENDED
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_stackable BOOLEAN NOT NULL DEFAULT true,
    eligible_stores JSONB DEFAULT '[]'::jsonb,
    eligible_products JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coupons_lookup ON coupons (organization_id, code, is_active);
CREATE INDEX IF NOT EXISTS idx_coupons_customer ON coupons (customer_id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    discount_amount_paise BIGINT NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_sale ON coupon_redemptions (sale_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_cust ON coupon_redemptions (customer_id, coupon_id);

-- 7. Loyalty Ledger & Accounts
CREATE TABLE IF NOT EXISTS loyalty_programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    earn_rate_spend_paise BIGINT NOT NULL DEFAULT 10000, -- e.g. 10000 paise (₹100) spend -> 1 credit
    credits_per_earn_unit NUMERIC(10,2) NOT NULL DEFAULT 1.0,
    redemption_rate_paise_per_credit BIGINT NOT NULL DEFAULT 25, -- e.g. 1 credit = 25 paise (₹0.25) -> 100 credits = ₹25
    min_redemption_credits INTEGER NOT NULL DEFAULT 50,
    max_redemption_pct NUMERIC(5,2) NOT NULL DEFAULT 50.0, -- max 50% of bill value
    credit_expiry_days INTEGER NOT NULL DEFAULT 365,
    exclude_taxes_from_earn BOOLEAN NOT NULL DEFAULT true,
    exclude_discounted_items BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_prog_org ON loyalty_programs (organization_id, is_active);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE RESTRICT,
    available_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    lifetime_earned NUMERIC(12,2) NOT NULL DEFAULT 0,
    lifetime_redeemed NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_acc_cust ON loyalty_accounts (customer_id);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    return_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    transaction_type VARCHAR(32) NOT NULL, -- EARN, REDEEM, REVERSAL, ADJUSTMENT, EXPIRY, BONUS
    credits NUMERIC(12,2) NOT NULL, -- positive or negative delta
    credits_balance_after NUMERIC(12,2) NOT NULL,
    monetary_value_paise BIGINT NOT NULL DEFAULT 0,
    notes TEXT,
    idempotency_key VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_acc ON loyalty_transactions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_cust ON loyalty_transactions (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_sale ON loyalty_transactions (sale_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_idem ON loyalty_transactions (idempotency_key);

-- 8. Supplier Schemes (Procurement Domain)
CREATE TABLE IF NOT EXISTS supplier_schemes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    scheme_type VARCHAR(64) NOT NULL, -- BUY_X_GET_Y_FREE, TRADE_DISCOUNT_PCT, FLAT_DISCOUNT, SCHEME_CREDIT
    medicine_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
    category_id UUID,
    manufacturer VARCHAR(255),
    min_quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
    free_quantity NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    flat_discount_paise BIGINT NOT NULL DEFAULT 0,
    scheme_credit_paise BIGINT NOT NULL DEFAULT 0,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    priority INTEGER NOT NULL DEFAULT 10,
    config_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_schemes_lookup ON supplier_schemes (organization_id, supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_supplier_schemes_med ON supplier_schemes (medicine_id);

-- 9. Sale Commercial Snapshots (Historical Audit & Exact Returns)
CREATE TABLE IF NOT EXISTS sale_commercial_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    mrp_total_paise BIGINT NOT NULL,
    base_total_paise BIGINT NOT NULL,
    promo_discount_paise BIGINT NOT NULL DEFAULT 0,
    coupon_discount_paise BIGINT NOT NULL DEFAULT 0,
    member_discount_paise BIGINT NOT NULL DEFAULT 0,
    manual_discount_paise BIGINT NOT NULL DEFAULT 0,
    loyalty_redeemed_paise BIGINT NOT NULL DEFAULT 0,
    loyalty_earned_credits NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_savings_paise BIGINT NOT NULL DEFAULT 0,
    gross_margin_paise BIGINT NOT NULL DEFAULT 0,
    gross_margin_pct NUMERIC(5,2) NOT NULL DEFAULT 0.0,
    applied_rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sale_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_comm_snap_sale ON sale_commercial_snapshots (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_comm_snap_org ON sale_commercial_snapshots (organization_id, created_at DESC);
