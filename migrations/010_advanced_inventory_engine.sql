-- 010_advanced_inventory_engine.sql
-- Task 5: Advanced Inventory Intelligence, Stocktake, Expiry, Recall & Replenishment Engine

-- 1. Extend inventory_positions with multi-state breakdown columns
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_quarantined NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_damaged NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_recalled NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_on_hold NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_stocktake_locked NUMERIC(15, 4) DEFAULT 0;

-- 2. Stocktake Sessions
CREATE TABLE IF NOT EXISTS stocktake_sessions (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'FULL', -- FULL, CATEGORY, PRODUCT_RANGE, BATCH, LOCATION, CYCLE_COUNT, HIGH_VALUE, EXPIRY, RANDOM
    scope JSONB, -- { category?: string, medicine_ids?: string[], rack_ids?: string[], abc_class?: string }
    counting_mode VARCHAR(50) NOT NULL DEFAULT 'LIVE_COUNT', -- HARD_FREEZE, SOFT_FREEZE, LIVE_COUNT
    is_blind_count BOOLEAN DEFAULT FALSE,
    is_double_count BOOLEAN DEFAULT FALSE,
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, PLANNED, IN_PROGRESS, COUNTING_COMPLETE, REVIEW, APPROVED, POSTED, CANCELLED
    initiated_by VARCHAR(100) NOT NULL,
    approved_by VARCHAR(100),
    reference_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stocktake_org_store ON stocktake_sessions(organization_id, store_id, status);
CREATE INDEX IF NOT EXISTS idx_stocktake_status ON stocktake_sessions(status);

-- 3. Stocktake Line Items (Aggregated / Reconciled items per SKU & Batch)
CREATE TABLE IF NOT EXISTS stocktake_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    stocktake_id UUID NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    batch_number VARCHAR(100),
    expiry_date VARCHAR(50),
    expected_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0,
    physical_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0,
    difference NUMERIC(15, 4) NOT NULL DEFAULT 0, -- physical - expected
    unit_cost_paise BIGINT NOT NULL DEFAULT 0,
    value_difference_paise BIGINT NOT NULL DEFAULT 0,
    variance_reason VARCHAR(100), -- COUNT_ERROR, DAMAGE, LOSS, THEFT_SUSPECTED, UNRECORDED_RETURN, UNRECORDED_PURCHASE, WRONG_BATCH, EXPIRY, SYSTEM_MISMATCH, OTHER
    recount_status VARCHAR(50) DEFAULT 'NONE', -- NONE, REQUESTED, COMPLETED, CONFLICT
    recount_count_a NUMERIC(15, 4),
    recount_count_b NUMERIC(15, 4),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id, medicine_id);

-- 4. Stocktake Raw Counts (Multi-counter & barcode scan capture)
CREATE TABLE IF NOT EXISTS stocktake_counts (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    stocktake_id UUID NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
    stocktake_item_id UUID REFERENCES stocktake_items(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    counter_name VARCHAR(100),
    user_id VARCHAR(100) NOT NULL,
    scanned_barcode VARCHAR(100),
    raw_quantity NUMERIC(15, 4) NOT NULL DEFAULT 1,
    unit_type VARCHAR(50) DEFAULT 'BASE',
    conversion_factor NUMERIC(15, 4) DEFAULT 1,
    base_quantity NUMERIC(15, 4) NOT NULL DEFAULT 1,
    device_id VARCHAR(100),
    is_offline_sync BOOLEAN DEFAULT FALSE,
    counted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stocktake_counts_item ON stocktake_counts(stocktake_item_id);

-- 5. Product Recalls
CREATE TABLE IF NOT EXISTS product_recalls (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    recall_reference VARCHAR(100) NOT NULL,
    recall_type VARCHAR(50) NOT NULL DEFAULT 'BATCH', -- PRODUCT, BATCH, MANUFACTURER_LOT
    product_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    batch_number VARCHAR(100),
    manufacturer VARCHAR(255),
    reason TEXT NOT NULL,
    severity VARCHAR(50) DEFAULT 'CLASS_I', -- CLASS_I (Critical/Life-threatening), CLASS_II (Temporary/Reversible), CLASS_III (Minor/Administrative)
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, ACTIVE, IN_PROGRESS, COMPLETED, CANCELLED
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    created_by VARCHAR(100) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recalls_org_prod ON product_recalls(organization_id, product_id, status);

-- 6. Recall Location Tasks
CREATE TABLE IF NOT EXISTS recall_tasks (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    recall_id UUID NOT NULL REFERENCES product_recalls(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    location_type VARCHAR(50) NOT NULL, -- STORE, WAREHOUSE
    expected_units NUMERIC(15, 4) NOT NULL DEFAULT 0,
    quarantined_units NUMERIC(15, 4) NOT NULL DEFAULT 0,
    discrepancy_units NUMERIC(15, 4) NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, QUARANTINED, COMPLETED
    assigned_to VARCHAR(100),
    completed_by VARCHAR(100),
    completed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recall_tasks_recall ON recall_tasks(recall_id, status);

-- 7. Inventory Reservations
CREATE TABLE IF NOT EXISTS inventory_reservations (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_type VARCHAR(50) NOT NULL, -- STORE, WAREHOUSE
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    quantity NUMERIC(15, 4) NOT NULL,
    source_type VARCHAR(50) NOT NULL, -- PARKED_SALE, PRESCRIPTION, ONLINE_ORDER, CLICK_COLLECT, TRANSFER, MANUAL
    source_id VARCHAR(100) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, CONSUMED, RELEASED, EXPIRED, CANCELLED
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inv_res_loc_prod ON inventory_reservations(organization_id, medicine_id, status, expires_at);

-- 8. Inventory Alerts
CREATE TABLE IF NOT EXISTS inventory_alerts (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    medicine_id UUID REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
    alert_type VARCHAR(50) NOT NULL, -- LOW_STOCK, STOCKOUT, EXPIRING, EXPIRED, DEAD_STOCK, HIGH_VARIANCE, RECALL, RECONCILIATION_MISMATCH, EXCESS_STOCK, RESERVATION_STUCK
    severity VARCHAR(50) NOT NULL DEFAULT 'WARNING', -- INFO, WARNING, CRITICAL
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN', -- OPEN, ACKNOWLEDGED, RESOLVED, DISMISSED
    acknowledged_by VARCHAR(100),
    acknowledged_at TIMESTAMPTZ,
    metadata JSONB,
    dedup_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inv_alerts_store ON inventory_alerts(organization_id, store_id, status);

-- 9. Stockout Events
CREATE TABLE IF NOT EXISTS stockout_events (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMPTZ,
    duration_hours NUMERIC(10, 2),
    estimated_lost_demand NUMERIC(15, 4) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stockout_events ON stockout_events(organization_id, store_id, medicine_id);

-- 10. Inventory Classifications Cache (ABC / Movement / Velocity)
CREATE TABLE IF NOT EXISTS inventory_classifications (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    abc_class VARCHAR(10) DEFAULT 'C', -- A, B, C
    movement_class VARCHAR(50) DEFAULT 'NORMAL', -- FAST_MOVING, NORMAL, SLOW_MOVING, NON_MOVING, DEAD_STOCK
    avg_daily_sales_7d NUMERIC(15, 4) DEFAULT 0,
    avg_daily_sales_30d NUMERIC(15, 4) DEFAULT 0,
    avg_daily_sales_90d NUMERIC(15, 4) DEFAULT 0,
    days_of_stock_cover NUMERIC(15, 2) DEFAULT 0,
    last_sale_date TIMESTAMPTZ,
    days_since_last_sale INTEGER DEFAULT 0,
    total_sales_units_90d NUMERIC(15, 4) DEFAULT 0,
    total_sales_value_paise_90d BIGINT DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_inv_class UNIQUE(organization_id, store_id, medicine_id)
);
