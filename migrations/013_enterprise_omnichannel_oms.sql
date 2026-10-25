-- 013_enterprise_omnichannel_oms.sql
-- Enterprise Omnichannel Order Management & Fulfilment Engine (OMS) Schema

-- 1. Customer Addresses Book
CREATE TABLE IF NOT EXISTS customer_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    label VARCHAR(50),
    recipient_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT,
    locality VARCHAR(255),
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    state_code VARCHAR(10),
    pincode VARCHAR(20) NOT NULL,
    landmark VARCHAR(255),
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    is_default BOOLEAN DEFAULT FALSE,
    delivery_instructions TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cust_addr_cust ON customer_addresses(customer_id, is_default) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cust_addr_pincode ON customer_addresses(pincode);

-- 2. Orders Master
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    order_number VARCHAR(100) NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES customers(id),
    patient_id UUID,
    source VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    channel VARCHAR(50) NOT NULL DEFAULT 'RETAIL',
    fulfilment_type VARCHAR(50) NOT NULL DEFAULT 'STORE_PICKUP',
    requested_store_id UUID REFERENCES stores(id),
    fulfilment_store_id UUID REFERENCES stores(id),
    fulfilment_warehouse_id UUID REFERENCES warehouses(id),
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    prescription_status VARCHAR(50) NOT NULL DEFAULT 'NOT_REQUIRED',
    payment_status VARCHAR(50) NOT NULL DEFAULT 'UNPAID',
    fulfilment_status VARCHAR(50) NOT NULL DEFAULT 'UNASSIGNED',
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    customer_notes TEXT,
    internal_notes TEXT,
    subtotal_paise BIGINT NOT NULL DEFAULT 0,
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    discount_total_paise BIGINT NOT NULL DEFAULT 0,
    discount_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tax_total_paise BIGINT NOT NULL DEFAULT 0,
    tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    loyalty_redemption_paise BIGINT NOT NULL DEFAULT 0,
    loyalty_redemption_credits BIGINT NOT NULL DEFAULT 0,
    delivery_charge_paise BIGINT NOT NULL DEFAULT 0,
    delivery_charge NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    round_off_paise BIGINT NOT NULL DEFAULT 0,
    round_off NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    grand_total_paise BIGINT NOT NULL DEFAULT 0,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    commercial_snapshot_id UUID,
    pickup_code VARCHAR(20),
    pickup_code_hash VARCHAR(128),
    pickup_verified_at TIMESTAMPTZ,
    pickup_verified_by UUID,
    sale_id UUID REFERENCES sales(id),
    idempotency_key VARCHAR(128) UNIQUE,
    quote_expires_at TIMESTAMPTZ,
    requested_fulfilment_at TIMESTAMPTZ,
    placed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason VARCHAR(100),
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_org_status ON orders(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(organization_id, fulfilment_store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(organization_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pickup_hash ON orders(pickup_code_hash) WHERE pickup_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_sale ON orders(sale_id) WHERE sale_id IS NOT NULL;

-- 3. Order Items
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    medicine_name VARCHAR(255) NOT NULL,
    requested_unit VARCHAR(50) NOT NULL DEFAULT 'STRIP',
    conversion_factor NUMERIC(10, 4) NOT NULL DEFAULT 1.0,
    requested_quantity NUMERIC(10, 2) NOT NULL DEFAULT 1.0,
    base_quantity NUMERIC(10, 2) NOT NULL DEFAULT 1.0,
    fulfilled_quantity NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    cancelled_quantity NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    substituted_quantity NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    prescription_required BOOLEAN DEFAULT FALSE,
    prescription_item_id UUID,
    prescription_id UUID,
    requested_product_snapshot JSONB,
    mrp_paise BIGINT NOT NULL DEFAULT 0,
    unit_price_paise BIGINT NOT NULL DEFAULT 0,
    discount_amount_paise BIGINT NOT NULL DEFAULT 0,
    taxable_amount_paise BIGINT NOT NULL DEFAULT 0,
    tax_amount_paise BIGINT NOT NULL DEFAULT 0,
    gst_rate NUMERIC(5, 2) NOT NULL DEFAULT 12.0,
    line_total_paise BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'REQUESTED',
    substitution_policy VARCHAR(50) NOT NULL DEFAULT 'NO_SUBSTITUTION',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_med ON order_items(organization_id, medicine_id);

-- 4. Order Address Snapshots
CREATE TABLE IF NOT EXISTS order_address_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    address_id UUID,
    recipient_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT,
    locality VARCHAR(255),
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    state_code VARCHAR(10),
    pincode VARCHAR(20) NOT NULL,
    landmark VARCHAR(255),
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    delivery_instructions TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_addr_snapshot_order ON order_address_snapshots(order_id);

-- 5. Order Commercial Snapshots
CREATE TABLE IF NOT EXISTS order_commercial_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pricing_version VARCHAR(50) DEFAULT 'V1',
    quote_json JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_comm_snapshot_order ON order_commercial_snapshots(order_id);

-- 6. Order Fulfilment Groups
CREATE TABLE IF NOT EXISTS order_fulfilments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    fulfilment_group_number INTEGER NOT NULL DEFAULT 1,
    fulfilment_type VARCHAR(50) NOT NULL DEFAULT 'STORE_PICKUP',
    location_type VARCHAR(20) NOT NULL DEFAULT 'STORE',
    store_id UUID REFERENCES stores(id),
    warehouse_id UUID REFERENCES warehouses(id),
    status VARCHAR(50) NOT NULL DEFAULT 'UNASSIGNED',
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    assigned_at TIMESTAMPTZ,
    pick_started_at TIMESTAMPTZ,
    picked_at TIMESTAMPTZ,
    packed_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_fulfilments_order ON order_fulfilments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_fulfilments_store ON order_fulfilments(store_id, status);

-- 7. Order Fulfilment Items
CREATE TABLE IF NOT EXISTS order_fulfilment_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fulfilment_id UUID NOT NULL REFERENCES order_fulfilments(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID REFERENCES medicine_batches(id),
    quantity_allocated NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    quantity_picked NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    quantity_packed NUMERIC(10, 2) NOT NULL DEFAULT 0.0,
    reservation_id UUID,
    status VARCHAR(50) NOT NULL DEFAULT 'RESERVED',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fulfilment_items_fulfilment ON order_fulfilment_items(fulfilment_id);
CREATE INDEX IF NOT EXISTS idx_fulfilment_items_item ON order_fulfilment_items(order_item_id);

-- 8. Order Packages
CREATE TABLE IF NOT EXISTS order_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    fulfilment_id UUID NOT NULL REFERENCES order_fulfilments(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    package_number INTEGER NOT NULL DEFAULT 1,
    package_label VARCHAR(100) NOT NULL,
    package_type VARCHAR(50) DEFAULT 'BOX',
    is_cold_chain BOOLEAN DEFAULT FALSE,
    is_prescription_required BOOLEAN DEFAULT FALSE,
    packed_by UUID NOT NULL,
    packed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    special_instructions TEXT,
    seal_number VARCHAR(100),
    weight_kg NUMERIC(8, 3),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_packages_order ON order_packages(order_id);

-- 9. Order Package Items
CREATE TABLE IF NOT EXISTS order_package_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID NOT NULL REFERENCES order_packages(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    fulfilment_id UUID NOT NULL REFERENCES order_fulfilments(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    medicine_id UUID NOT NULL REFERENCES medicines(id),
    batch_id UUID REFERENCES medicine_batches(id),
    quantity NUMERIC(10, 2) NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_package_items_package ON order_package_items(package_id);

-- 10. Order Substitutions
CREATE TABLE IF NOT EXISTS order_substitutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    original_medicine_id UUID NOT NULL REFERENCES medicines(id),
    original_medicine_name VARCHAR(255) NOT NULL,
    suggested_medicine_id UUID NOT NULL REFERENCES medicines(id),
    suggested_medicine_name VARCHAR(255) NOT NULL,
    original_unit_price_paise BIGINT NOT NULL DEFAULT 0,
    suggested_unit_price_paise BIGINT NOT NULL DEFAULT 0,
    price_difference_paise BIGINT NOT NULL DEFAULT 0,
    quantity NUMERIC(10, 2) NOT NULL DEFAULT 1.0,
    reason TEXT NOT NULL,
    requested_by UUID NOT NULL,
    customer_confirmed BOOLEAN DEFAULT FALSE,
    customer_confirmed_at TIMESTAMPTZ,
    pharmacist_verified BOOLEAN DEFAULT FALSE,
    pharmacist_verified_by UUID,
    pharmacist_verified_at TIMESTAMPTZ,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_substitutions_order ON order_substitutions(order_id);

-- 11. Order Refunds
CREATE TABLE IF NOT EXISTS order_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    payment_transaction_id UUID,
    amount_paise BIGINT NOT NULL DEFAULT 0,
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reason TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    refund_reference VARCHAR(100),
    processed_by UUID,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds(order_id);

-- 12. Order Events Timeline
CREATE TABLE IF NOT EXISTS order_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    fulfilment_id UUID,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    from_status VARCHAR(50),
    to_status VARCHAR(50),
    actor_id UUID,
    actor_name VARCHAR(255),
    details_json JSONB DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at ASC);

-- 13. Order Transfer Links
CREATE TABLE IF NOT EXISTS order_transfer_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id UUID,
    transfer_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'LINKED',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    _local_id TEXT,
    _synced BOOLEAN DEFAULT TRUE,
    _deleted BOOLEAN DEFAULT FALSE,
    _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_transfers_order ON order_transfer_links(order_id);

-- 14. Additive columns for existing tables
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);
