-- 012_multi_store_transfers_warehouse_ops.sql
-- Task 7: Multi-Store Transfers, Warehouse Operations & Central Replenishment

-- ──────────────────────────────────────────
-- 1. TRANSFER POLICIES
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_policies (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                           TEXT UNIQUE,
  organization_id                     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  auto_approve_routine_transfers      BOOLEAN DEFAULT false,
  auto_approve_value_limit_paise      BIGINT DEFAULT 1000000, -- Up to ₹10,000 auto-approved
  store_manager_approval_limit_paise  BIGINT DEFAULT 5000000, -- Up to ₹50,000 Store Manager
  regional_manager_approval_limit_paise BIGINT DEFAULT 20000000, -- Up to ₹2,00,000 Regional Manager
  enforce_maker_checker               BOOLEAN DEFAULT false,
  require_pack_verification           BOOLEAN DEFAULT true,
  require_fefo_allocation             BOOLEAN DEFAULT true,
  min_shelf_life_days_transfer        INTEGER DEFAULT 60,
  allow_partial_receipt               BOOLEAN DEFAULT true,
  auto_close_on_exact_receipt         BOOLEAN DEFAULT true,
  created_at                          TIMESTAMPTZ DEFAULT now(),
  updated_at                          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (organization_id)
);
CREATE INDEX IF NOT EXISTS idx_transfer_policies_org ON transfer_policies(organization_id);

-- ──────────────────────────────────────────
-- 2. WAREHOUSE BINS & STORAGE LOCATIONS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouse_bins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id      UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  parent_bin_id     UUID REFERENCES warehouse_bins(id) ON DELETE SET NULL,
  bin_code          TEXT NOT NULL,
  bin_name          TEXT NOT NULL,
  zone              TEXT,
  rack              TEXT,
  shelf             TEXT,
  bin_type          TEXT DEFAULT 'STORAGE' CHECK (bin_type IN ('STORAGE', 'STAGING', 'PICKING', 'PACKING', 'COLD_ROOM', 'QUARANTINE', 'RECALL', 'DAMAGE')),
  pick_sequence     INTEGER DEFAULT 100,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (organization_id, warehouse_id, bin_code)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_bins_wh ON warehouse_bins(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_bins_code ON warehouse_bins(bin_code);

CREATE TABLE IF NOT EXISTS inventory_bin_positions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id      UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  bin_id            UUID NOT NULL REFERENCES warehouse_bins(id) ON DELETE CASCADE,
  medicine_id       UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id          UUID NOT NULL,
  quantity          NUMERIC NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (organization_id, warehouse_id, bin_id, medicine_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_bin_positions_med_batch ON inventory_bin_positions(medicine_id, batch_id);

-- ──────────────────────────────────────────
-- 3. STOCK TRANSFERS (Header)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfers (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transfer_number           TEXT NOT NULL,
  transfer_type             TEXT NOT NULL CHECK (transfer_type IN ('STORE_TO_STORE', 'WAREHOUSE_TO_STORE', 'STORE_TO_WAREHOUSE', 'WAREHOUSE_TO_WAREHOUSE', 'RETURN_TO_SOURCE', 'RECALL_TRANSFER', 'EMERGENCY_TRANSFER', 'REBALANCING')),
  source_location_type      TEXT NOT NULL CHECK (source_location_type IN ('STORE', 'WAREHOUSE')),
  source_location_id        UUID NOT NULL,
  destination_location_type TEXT NOT NULL CHECK (destination_location_type IN ('STORE', 'WAREHOUSE')),
  destination_location_id   UUID NOT NULL,
  source_name               TEXT,
  destination_name          TEXT,
  priority                  TEXT DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL')),
  reason                    TEXT DEFAULT 'MANUAL' CHECK (reason IN ('MANUAL', 'REORDER_ENGINE', 'WAREHOUSE_REPLENISHMENT', 'STORE_REBALANCING', 'STOCKOUT', 'PRESCRIPTION_DEMAND', 'SHORTBOOK', 'NEAR_EXPIRY', 'RECALL', 'EMERGENCY')),
  status                    TEXT DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'ALLOCATING', 'READY_TO_PICK', 'PICKING', 'PICKED', 'PACKED', 'DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'VARIANCE_REVIEW', 'CLOSED', 'CANCELLED', 'REJECTED')),
  stock_state_transferred   TEXT DEFAULT 'AVAILABLE' CHECK (stock_state_transferred IN ('AVAILABLE', 'QUARANTINED', 'RECALLED', 'DAMAGED')),
  total_items               INTEGER DEFAULT 0,
  total_quantity_requested  NUMERIC DEFAULT 0,
  total_quantity_dispatched NUMERIC DEFAULT 0,
  total_quantity_received   NUMERIC DEFAULT 0,
  total_value_paise         BIGINT DEFAULT 0,
  requested_by              UUID NOT NULL,
  requested_at              TIMESTAMPTZ DEFAULT now(),
  required_by_date          DATE,
  approved_by               UUID,
  approved_at               TIMESTAMPTZ,
  rejection_reason          TEXT,
  rejected_by               UUID,
  rejected_at               TIMESTAMPTZ,
  pick_started_at           TIMESTAMPTZ,
  picked_by                 UUID,
  picked_at                 TIMESTAMPTZ,
  packed_by                 UUID,
  packed_at                 TIMESTAMPTZ,
  package_count             INTEGER DEFAULT 0,
  is_cold_chain             BOOLEAN DEFAULT false,
  carrier_name              TEXT,
  tracking_reference        TEXT,
  dispatched_by             UUID,
  dispatched_at             TIMESTAMPTZ,
  estimated_arrival_at      TIMESTAMPTZ,
  received_by               UUID,
  received_at               TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  cancelled_by              UUID,
  cancelled_at              TIMESTAMPTZ,
  cancellation_reason       TEXT,
  notes                     TEXT,
  idempotency_key           TEXT,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  UNIQUE (organization_id, transfer_number)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_org ON stock_transfers(organization_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_source ON stock_transfers(source_location_type, source_location_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_dest ON stock_transfers(destination_location_type, destination_location_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_date ON stock_transfers(created_at);

-- ──────────────────────────────────────────
-- 4. STOCK TRANSFER ITEMS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  medicine_name             TEXT,
  requested_unit            TEXT DEFAULT 'strip',
  conversion_factor         NUMERIC DEFAULT 1.0,
  requested_quantity        NUMERIC NOT NULL,
  base_quantity_requested   NUMERIC NOT NULL,
  allocated_quantity        NUMERIC DEFAULT 0,
  picked_quantity           NUMERIC DEFAULT 0,
  dispatched_quantity       NUMERIC DEFAULT 0,
  received_quantity         NUMERIC DEFAULT 0,
  damaged_quantity          NUMERIC DEFAULT 0,
  short_quantity            NUMERIC DEFAULT 0,
  excess_quantity           NUMERIC DEFAULT 0,
  rejected_quantity         NUMERIC DEFAULT 0,
  unit_cost_paise           INTEGER DEFAULT 0,
  total_value_paise         BIGINT DEFAULT 0,
  source_stock_snapshot     NUMERIC DEFAULT 0,
  destination_stock_snapshot NUMERIC DEFAULT 0,
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON stock_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_items_medicine ON stock_transfer_items(medicine_id);

-- ──────────────────────────────────────────
-- 5. STOCK TRANSFER BATCH ALLOCATIONS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfer_batch_allocations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  transfer_item_id          UUID NOT NULL REFERENCES stock_transfer_items(id) ON DELETE CASCADE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  batch_id                  UUID NOT NULL,
  batch_number              TEXT NOT NULL,
  expiry_date               DATE NOT NULL,
  unit_cost_paise           INTEGER NOT NULL DEFAULT 0,
  mrp_paise                 INTEGER DEFAULT 0,
  quantity_allocated        NUMERIC NOT NULL DEFAULT 0,
  quantity_picked           NUMERIC DEFAULT 0,
  quantity_dispatched       NUMERIC DEFAULT 0,
  quantity_received         NUMERIC DEFAULT 0,
  quantity_damaged          NUMERIC DEFAULT 0,
  quantity_short            NUMERIC DEFAULT 0,
  quantity_excess           NUMERIC DEFAULT 0,
  reservation_id            UUID,
  source_bin_id             UUID,
  destination_bin_id        UUID,
  is_picked                 BOOLEAN DEFAULT false,
  picked_at                 TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_alloc_item ON stock_transfer_batch_allocations(transfer_item_id);
CREATE INDEX IF NOT EXISTS idx_transfer_alloc_batch ON stock_transfer_batch_allocations(batch_id);

-- ──────────────────────────────────────────
-- 6. TRANSFER PACKAGES & LABELS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_packages (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  package_identifier        TEXT NOT NULL, -- e.g. TRF-HYDWH-DP01-0001/PKG-01
  package_number            INTEGER NOT NULL DEFAULT 1,
  package_type              TEXT DEFAULT 'BOX' CHECK (package_type IN ('BOX', 'BAG', 'CONTAINER', 'COLD_BOX', 'PALLET')),
  is_cold_chain             BOOLEAN DEFAULT false,
  packed_by                 UUID NOT NULL,
  packed_at                 TIMESTAMPTZ DEFAULT now(),
  weight_kg                 NUMERIC,
  special_instructions      TEXT,
  seal_number               TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_packages_trf ON transfer_packages(transfer_id);

CREATE TABLE IF NOT EXISTS transfer_package_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  package_id                UUID NOT NULL REFERENCES transfer_packages(id) ON DELETE CASCADE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  transfer_item_id          UUID NOT NULL REFERENCES stock_transfer_items(id) ON DELETE CASCADE,
  batch_allocation_id       UUID NOT NULL REFERENCES stock_transfer_batch_allocations(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL,
  batch_id                  UUID NOT NULL,
  quantity_packed           NUMERIC NOT NULL,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_package_items_pkg ON transfer_package_items(package_id);

-- ──────────────────────────────────────────
-- 7. TRANSFER RECEIPTS & LINE COUNTS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_receipts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_number            TEXT NOT NULL,
  received_by               UUID NOT NULL,
  received_at               TIMESTAMPTZ DEFAULT now(),
  status                    TEXT DEFAULT 'COMPLETED' CHECK (status IN ('DRAFT', 'COMPLETED', 'VARIANCE_HOLD')),
  condition_status          TEXT DEFAULT 'GOOD' CHECK (condition_status IN ('GOOD', 'DAMAGED_PACKAGING', 'TEMPERATURE_BREACH', 'TAMPERED')),
  notes                     TEXT,
  idempotency_key           TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_receipts_trf ON transfer_receipts(transfer_id);

CREATE TABLE IF NOT EXISTS transfer_receipt_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  receipt_id                UUID NOT NULL REFERENCES transfer_receipts(id) ON DELETE CASCADE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  transfer_item_id          UUID NOT NULL REFERENCES stock_transfer_items(id) ON DELETE CASCADE,
  batch_allocation_id       UUID NOT NULL REFERENCES stock_transfer_batch_allocations(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL,
  batch_id                  UUID NOT NULL,
  quantity_dispatched       NUMERIC NOT NULL,
  quantity_accepted         NUMERIC NOT NULL,
  quantity_damaged          NUMERIC DEFAULT 0,
  quantity_short            NUMERIC DEFAULT 0,
  quantity_excess           NUMERIC DEFAULT 0,
  quantity_rejected         NUMERIC DEFAULT 0,
  destination_bin_id        UUID,
  damage_notes              TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_items_rec ON transfer_receipt_items(receipt_id);

-- ──────────────────────────────────────────
-- 8. TRANSFER VARIANCES & RESOLUTIONS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_variances (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  receipt_id                UUID REFERENCES transfer_receipts(id) ON DELETE SET NULL,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL,
  batch_id                  UUID NOT NULL,
  variance_type             TEXT NOT NULL CHECK (variance_type IN ('SHORT', 'EXCESS', 'DAMAGED', 'WRONG_PRODUCT', 'WRONG_BATCH', 'EXPIRED', 'PACKAGE_MISSING', 'COUNT_MISMATCH', 'OTHER')),
  expected_quantity         NUMERIC NOT NULL,
  actual_quantity           NUMERIC NOT NULL,
  variance_quantity         NUMERIC NOT NULL,
  unit_cost_paise           INTEGER NOT NULL DEFAULT 0,
  variance_value_paise      BIGINT NOT NULL DEFAULT 0,
  status                    TEXT DEFAULT 'REPORTED' CHECK (status IN ('REPORTED', 'INVESTIGATING', 'APPROVED', 'RESOLVED', 'REJECTED')),
  resolution                TEXT CHECK (resolution IN ('ACCEPT_VARIANCE', 'RECOUNT', 'SOURCE_CORRECTION', 'DESTINATION_CORRECTION', 'RETURN_TO_SOURCE', 'STOCK_ADJUSTMENT', 'INVESTIGATION')),
  resolution_notes          TEXT,
  reported_by               UUID NOT NULL,
  reported_at               TIMESTAMPTZ DEFAULT now(),
  resolved_by               UUID,
  resolved_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_variances_trf ON transfer_variances(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_variances_status ON transfer_variances(status);

-- ──────────────────────────────────────────
-- 9. TRANSFER EVENTS (Immutable Audit Log)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_events (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  transfer_id               UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type                TEXT NOT NULL,
  from_status               TEXT,
  to_status                 TEXT,
  performed_by              UUID NOT NULL,
  performer_name            TEXT,
  details_json              JSONB DEFAULT '{}',
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_events_trf ON transfer_events(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_events_type ON transfer_events(event_type);
