-- 006_enterprise_multi_store_foundation.sql
-- Enterprise Pharmacy Domain & Multi-Store Organization Architecture

-- ──────────────────────────────────────────
-- 1. ORGANIZATIONS (Enterprise Root Entity)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  legal_name            TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  code                  TEXT UNIQUE NOT NULL,
  gstin                 TEXT,
  pan                   TEXT,
  registered_address    TEXT,
  billing_address       TEXT,
  phone                 TEXT,
  email                 TEXT,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  timezone              TEXT DEFAULT 'Asia/Kolkata',
  currency              TEXT DEFAULT 'INR',
  financial_year_start  TEXT DEFAULT '04-01',
  default_state_code    TEXT DEFAULT '36',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_organizations_code ON organizations(code);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

-- Add organization_id reference to clinics (non-destructive link)
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clinics_org_id ON clinics(organization_id);

-- ──────────────────────────────────────────
-- 2. REGIONS / ZONES (Geographic / Operational Clusters)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS regions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  parent_region_id  UUID REFERENCES regions(id) ON DELETE SET NULL,
  manager_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_regions_org ON regions(organization_id);
CREATE INDEX IF NOT EXISTS idx_regions_parent ON regions(parent_region_id);

-- ──────────────────────────────────────────
-- 3. STORES / PHARMACIES (Operational Locations)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stores (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  region_id                 UUID REFERENCES regions(id) ON DELETE SET NULL,
  clinic_id                 UUID REFERENCES clinics(id) ON DELETE SET NULL,
  store_code                TEXT NOT NULL,
  name                      TEXT NOT NULL,
  display_name              TEXT,
  address                   TEXT,
  locality                  TEXT,
  city                      TEXT,
  district                  TEXT,
  state                     TEXT,
  state_code                TEXT,
  pincode                   TEXT,
  latitude                  NUMERIC,
  longitude                 NUMERIC,
  gstin_override            TEXT,
  drug_licence_number       TEXT,
  secondary_licence_number  TEXT,
  phone                     TEXT,
  email                     TEXT,
  opening_time              TEXT DEFAULT '09:00',
  closing_time              TEXT DEFAULT '22:00',
  timezone                  TEXT DEFAULT 'Asia/Kolkata',
  status                    TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  fulfilment_enabled        BOOLEAN DEFAULT true,
  delivery_enabled          BOOLEAN DEFAULT false,
  click_collect_enabled     BOOLEAN DEFAULT false,
  warehouse_served_by       UUID,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  UNIQUE (organization_id, store_code)
);
CREATE INDEX IF NOT EXISTS idx_stores_org ON stores(organization_id);
CREATE INDEX IF NOT EXISTS idx_stores_region ON stores(region_id);
CREATE INDEX IF NOT EXISTS idx_stores_clinic ON stores(clinic_id);

-- ──────────────────────────────────────────
-- 4. WAREHOUSES (Distribution / Storage Hubs)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id               TEXT UNIQUE,
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  region_id               UUID REFERENCES regions(id) ON DELETE SET NULL,
  warehouse_code          TEXT NOT NULL,
  name                    TEXT NOT NULL,
  address                 TEXT,
  gstin                   TEXT,
  state_code              TEXT,
  status                  TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  cold_storage_supported  BOOLEAN DEFAULT false,
  manager_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  deleted_at              TIMESTAMPTZ,
  UNIQUE (organization_id, warehouse_code)
);
CREATE INDEX IF NOT EXISTS idx_warehouses_org ON warehouses(organization_id);

-- ──────────────────────────────────────────
-- 5. COUNTERS (Store Billing Points)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id       TEXT UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  counter_code    TEXT NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (store_id, counter_code)
);
CREATE INDEX IF NOT EXISTS idx_counters_store ON counters(store_id);

-- ──────────────────────────────────────────
-- 6. TERMINALS / DEVICES (Physical Station Registrations)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS terminals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  counter_id          UUID REFERENCES counters(id) ON DELETE SET NULL,
  device_uuid         TEXT NOT NULL,
  terminal_code       TEXT NOT NULL,
  terminal_name       TEXT NOT NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('WEB', 'DESKTOP', 'ANDROID', 'IOS')),
  app_version         TEXT,
  last_seen_at        TIMESTAMPTZ,
  last_sync_at        TIMESTAMPTZ,
  status              TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'revoked')),
  printer_profile_id  UUID,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (organization_id, device_uuid),
  UNIQUE (store_id, terminal_code)
);
CREATE INDEX IF NOT EXISTS idx_terminals_store ON terminals(store_id);
CREATE INDEX IF NOT EXISTS idx_terminals_counter ON terminals(counter_id);

-- ──────────────────────────────────────────
-- 7. USER ACCESS CONTROL MAPPINGS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_organization_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id       TEXT UNIQUE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('OWNER', 'REGIONAL_MANAGER', 'PHARMACIST', 'CASHIER', 'DOCTOR', 'STAFF', 'VIEWER')),
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_uoa_user ON user_organization_access(user_id);
CREATE INDEX IF NOT EXISTS idx_uoa_org ON user_organization_access(organization_id);

CREATE TABLE IF NOT EXISTS user_store_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id       TEXT UNIQUE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  counter_id      UUID REFERENCES counters(id) ON DELETE SET NULL,
  role            TEXT NOT NULL CHECK (role IN ('STORE_MANAGER', 'PHARMACIST', 'CASHIER', 'DOCTOR', 'STAFF', 'VIEWER')),
  is_default      BOOLEAN DEFAULT false,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (user_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_usa_user ON user_store_access(user_id);
CREATE INDEX IF NOT EXISTS idx_usa_store ON user_store_access(store_id);

-- ──────────────────────────────────────────
-- 8. FINANCIAL YEARS & DOCUMENT SEQUENCES
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_years (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id       TEXT UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  status          TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fy_org ON financial_years(organization_id);

CREATE TABLE IF NOT EXISTS document_sequences (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE CASCADE,
  document_type     TEXT NOT NULL CHECK (
                      document_type IN (
                        'SALE_INVOICE',
                        'SALE_RETURN',
                        'PURCHASE',
                        'PURCHASE_RETURN',
                        'PURCHASE_ORDER',
                        'GRN',
                        'TRANSFER',
                        'STOCK_ADJUSTMENT',
                        'CREDIT_NOTE',
                        'DEBIT_NOTE',
                        'DELIVERY_ORDER'
                      )
                    ),
  financial_year_id UUID REFERENCES financial_years(id) ON DELETE SET NULL,
  prefix            TEXT NOT NULL,
  suffix            TEXT DEFAULT '',
  padding           INTEGER DEFAULT 4,
  current_sequence  INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (organization_id, store_id, document_type, financial_year_id)
);
CREATE INDEX IF NOT EXISTS idx_docseq_lookup ON document_sequences(organization_id, store_id, document_type);

-- ──────────────────────────────────────────
-- 9. INVENTORY POSITIONS (Per-Location Physical Stock)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id         UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id            UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
  location_type       TEXT NOT NULL CHECK (location_type IN ('STORE', 'WAREHOUSE')),
  store_id            UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id        UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity_on_hand    INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_available  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
  quantity_in_transit INTEGER NOT NULL DEFAULT 0 CHECK (quantity_in_transit >= 0),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT chk_location_target CHECK (
    (location_type = 'STORE' AND store_id IS NOT NULL AND warehouse_id IS NULL) OR
    (location_type = 'WAREHOUSE' AND warehouse_id IS NOT NULL AND store_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_invpos_store ON inventory_positions(store_id, medicine_id);
CREATE INDEX IF NOT EXISTS idx_invpos_batch ON inventory_positions(batch_id);
CREATE INDEX IF NOT EXISTS idx_invpos_med_loc ON inventory_positions(medicine_id, location_type);

-- ──────────────────────────────────────────
-- 10. PRODUCT MASTER EXPANSION & BARCODES
-- ──────────────────────────────────────────
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS product_type TEXT DEFAULT 'MEDICINE' CHECK (product_type IN ('MEDICINE', 'OTC', 'SURGICAL', 'MEDICAL_DEVICE', 'FMCG', 'WELLNESS', 'COSMETIC', 'PERSONAL_CARE', 'CONSUMABLE', 'OTHER'));
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS brand_name TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS composition TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS dosage_form TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS strength TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS pack_size TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS base_unit TEXT DEFAULT 'strip';
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS sale_unit TEXT DEFAULT 'strip';
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC DEFAULT 1.0;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS marketer TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS subcategory_id UUID;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS primary_barcode TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS prescription_required BOOLEAN DEFAULT false;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS schedule_classification TEXT DEFAULT 'NONE' CHECK (schedule_classification IN ('NONE', 'SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X', 'NARCOTIC'));
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS cold_chain_required BOOLEAN DEFAULT false;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS storage_instructions TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS minimum_margin_percent NUMERIC DEFAULT 0;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS preferred_supplier_id UUID;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS discontinued_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_medicines_org_active ON medicines(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_medicines_product_type ON medicines(product_type);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id       UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  barcode           TEXT NOT NULL,
  barcode_type      TEXT NOT NULL CHECK (barcode_type IN ('MANUFACTURER', 'INTERNAL', 'PACK', 'STRIP', 'UNIT')),
  unit_type         TEXT NOT NULL CHECK (unit_type IN ('BOX', 'PACK', 'STRIP', 'TABLET', 'CAPSULE', 'BOTTLE', 'VIAL', 'AMPOULE', 'TUBE', 'SACHET', 'UNIT')),
  conversion_factor NUMERIC NOT NULL DEFAULT 1.0,
  is_primary        BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (organization_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_barcodes_org_code ON product_barcodes(organization_id, barcode);
CREATE INDEX IF NOT EXISTS idx_barcodes_medicine ON product_barcodes(medicine_id);

-- ──────────────────────────────────────────
-- 11. ADDITIVE LOCATION CONTEXT TO TRANSACTIONAL TABLES
-- ──────────────────────────────────────────
-- medicine_batches
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_batches_store ON medicine_batches(store_id, medicine_id);

-- sales
ALTER TABLE sales ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS counter_id UUID REFERENCES counters(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_org_invoice ON sales(organization_id, invoice_number);

-- sale_items
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sale_items_store ON sale_items(store_id);

-- purchases
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS counter_id UUID REFERENCES counters(id) ON DELETE SET NULL;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_store_date ON purchases(store_id, created_at DESC);

-- purchase_items
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_items_store ON purchase_items(store_id);

-- expenses
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS counter_id UUID REFERENCES counters(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses(store_id, expense_date DESC);

-- customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customers_store ON customers(store_id);

-- suppliers
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_store ON suppliers(store_id);

-- ──────────────────────────────────────────
-- 12. EXTEND STOCK LEDGER
-- ──────────────────────────────────────────
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS source_location_type TEXT;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS source_location_id UUID;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS destination_location_type TEXT;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS destination_location_id UUID;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS counter_id UUID REFERENCES counters(id) ON DELETE SET NULL;
ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_time ON stock_ledger(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_med  ON stock_ledger(store_id, medicine_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_batch ON stock_ledger(store_id, batch_id);

-- Expand movement_type check constraint safely on PostgreSQL
DO $$
BEGIN
  ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_movement_type_check;
  ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_movement_type_check CHECK (
    movement_type IN (
      'OPENING_STOCK',
      'SALE',
      'SALE_RETURN',
      'PURCHASE_RECEIPT',
      'PURCHASE_RETURN',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'ADJUSTMENT_PLUS',
      'ADJUSTMENT_MINUS',
      'DAMAGE',
      'EXPIRY',
      'DISPOSAL',
      'RECALL',
      'STOCKTAKE_CORRECTION',
      'RESERVATION',
      'RESERVATION_RELEASE',
      'WAREHOUSE_RECEIPT',
      'WAREHOUSE_DISPATCH'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Table constraint update fallback
  NULL;
END $$;
