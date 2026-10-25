-- ============================================================================
-- Migration 007: Enterprise POS Counter Engine V2
-- Multi-Tender Payments, Multi-Batch Allocations, Parked Sales, Supervisor Approvals
-- ============================================================================

-- 1. Payment Transactions Table (Normalized Split Tenders)
CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    store_id UUID REFERENCES stores(id) ON DELETE RESTRICT,
    terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    return_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    tender_type VARCHAR(32) NOT NULL DEFAULT 'CASH', -- CASH, UPI, CARD, CREDIT, WALLET, LOYALTY, VOUCHER, OTHER
    amount NUMERIC(15,2) NOT NULL,
    amount_paise BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    reference_number VARCHAR(128), -- UPI Ref ID, Card Last 4 / Auth Code, Voucher Code
    status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED', -- PENDING, COMPLETED, FAILED, REFUNDED, VOIDED
    provider VARCHAR(64), -- MANUAL_CONFIRMED, RAZORPAY, PAYTM, PINELABS, etc.
    change_returned_paise BIGINT NOT NULL DEFAULT 0, -- Cash change given back
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_sale ON payment_transactions (sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_org_store ON payment_transactions (organization_id, store_id, tender_type, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_tx_created ON payment_transactions (created_at DESC);

-- 2. Sale Batch Allocations Table (Multi-Batch Granular Traceability for Single Item)
CREATE TABLE IF NOT EXISTS sale_batch_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    store_id UUID REFERENCES stores(id) ON DELETE RESTRICT,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE RESTRICT,
    allocated_quantity NUMERIC(10,2) NOT NULL, -- in selected unit
    base_quantity NUMERIC(10,2) NOT NULL, -- normalized base/loose quantity for stock deduction
    unit_type VARCHAR(32) NOT NULL DEFAULT 'STRIP',
    unit_price NUMERIC(15,2) NOT NULL,
    cost_price NUMERIC(15,2) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_sale ON sale_batch_allocations (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_item ON sale_batch_allocations (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_batch ON sale_batch_allocations (batch_id);

-- 3. Parked Sales Table (Hold / Park / Cross-Counter Resume Engine)
CREATE TABLE IF NOT EXISTS parked_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    counter_id UUID REFERENCES counters(id) ON DELETE SET NULL,
    terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    cashier_id UUID NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    park_token VARCHAR(32) NOT NULL, -- e.g., P101, P102
    cart_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    customer_snapshot JSONB DEFAULT '{}'::jsonb,
    totals_snapshot JSONB DEFAULT '{}'::jsonb,
    notes TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'PARKED', -- PARKED, RESUMED, CANCELLED, EXPIRED, COMPLETED
    resumed_at TIMESTAMPTZ,
    resumed_counter_id UUID REFERENCES counters(id) ON DELETE SET NULL,
    resumed_terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    resumed_by UUID,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parked_sales_org_store ON parked_sales (organization_id, store_id, status);
CREATE INDEX IF NOT EXISTS idx_parked_sales_token ON parked_sales (store_id, park_token);

-- 4. Supervisor Authorizations Table (Audited Overrides for Discounts, Prices, Returns, Expiry)
CREATE TABLE IF NOT EXISTS supervisor_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    counter_id UUID REFERENCES counters(id) ON DELETE SET NULL,
    terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    action_type VARCHAR(64) NOT NULL, -- HIGH_DISCOUNT, PRICE_OVERRIDE, NEAR_EXPIRY_SALE, RETURN_OVERRIDE, SALE_CANCELLATION, BATCH_OVERRIDE
    requesting_user_id UUID NOT NULL,
    authorizing_user_id UUID NOT NULL,
    entity_type VARCHAR(64), -- SALE, SALE_ITEM, RETURN
    entity_id VARCHAR(128),
    reason TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'APPROVED', -- APPROVED, REJECTED, PENDING
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _local_id VARCHAR(64) UNIQUE,
    _synced SMALLINT NOT NULL DEFAULT 0,
    _deleted SMALLINT NOT NULL DEFAULT 0,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supervisor_auth_org_store ON supervisor_authorizations (organization_id, store_id, action_type, created_at);

-- 5. Additive Columns on Sales & Sale Items
ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS doctor_name VARCHAR(128),
    ADD COLUMN IF NOT EXISTS doctor_registration_number VARCHAR(64),
    ADD COLUMN IF NOT EXISTS prescription_number VARCHAR(64),
    ADD COLUMN IF NOT EXISTS prescription_image_url TEXT,
    ADD COLUMN IF NOT EXISTS prescription_required BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
    ADD COLUMN IF NOT EXISTS is_parked BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS park_id UUID,
    ADD COLUMN IF NOT EXISTS exchange_of_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS credit_note_number VARCHAR(64);

ALTER TABLE sale_items
    ADD COLUMN IF NOT EXISTS unit_type VARCHAR(32) DEFAULT 'STRIP',
    ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(10,4) DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS base_quantity NUMERIC(10,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mrp_paise BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unit_price_paise BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_amount_paise BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS taxable_amount_paise BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tax_amount_paise BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(32) DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS is_prescription_required BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sales_idempotency ON sales (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_credit_note ON sales (credit_note_number) WHERE credit_note_number IS NOT NULL;
