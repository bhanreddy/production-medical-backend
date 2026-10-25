-- schema.sql (Canonical Enterprise Domain Model)

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

-- ──────────────────────────────────────────
-- CLINICS (Tenants - Backward Compatible)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID REFERENCES organizations(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  slug                TEXT UNIQUE,
  address             TEXT,
  phone               TEXT,
  email               TEXT,
  gstin               TEXT,
  drug_licence_number TEXT,
  upi_vpa             TEXT,
  subscription_id     TEXT,
  plan                TEXT DEFAULT 'trial' CHECK (plan IN ('trial','basic','pro','custom')),
  trial_ends_at       TIMESTAMPTZ,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clinics_slug      ON clinics(slug);
CREATE INDEX IF NOT EXISTS idx_clinics_is_active ON clinics(is_active);
CREATE INDEX IF NOT EXISTS idx_clinics_org_id    ON clinics(organization_id);

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
  manager_user_id   UUID,
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
  manager_user_id         UUID,
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
-- USERS & ACCESS MAPPINGS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_id TEXT UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  password    TEXT,
  full_name   TEXT,
  phone       TEXT,
  role        TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','OWNER','PHARMACIST','CASHIER','DOCTOR','STAFF')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clinic_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('OWNER','PHARMACIST','CASHIER','DOCTOR','STAFF')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (clinic_id, user_id)
);

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
-- FINANCIAL YEARS & DOCUMENT SEQUENCES
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
-- CUSTOMERS (PATIENTS)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID REFERENCES stores(id) ON DELETE SET NULL,
  clinic_id           UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  doctor_name         TEXT,
  gstin               TEXT,
  outstanding_balance NUMERIC DEFAULT 0,
  importance_score    INTEGER DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_customers_clinic_phone ON customers(clinic_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_clinic_name  ON customers(clinic_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_store        ON customers(store_id);

-- ──────────────────────────────────────────
-- SUPPLIERS (VENDORS)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID REFERENCES stores(id) ON DELETE SET NULL,
  clinic_id           UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  gstin               TEXT,
  dl_number           TEXT,
  outstanding_balance NUMERIC DEFAULT 0,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_suppliers_clinic_name ON suppliers(clinic_id, name);
CREATE INDEX IF NOT EXISTS idx_suppliers_store       ON suppliers(store_id);

-- ──────────────────────────────────────────
-- MEDICINES & HEALTHCARE PRODUCTS (MASTER CATALOGUE)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medicines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id               TEXT UNIQUE,
  organization_id         UUID REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id               UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  product_type            TEXT DEFAULT 'MEDICINE' CHECK (product_type IN ('MEDICINE', 'OTC', 'SURGICAL', 'MEDICAL_DEVICE', 'FMCG', 'WELLNESS', 'COSMETIC', 'PERSONAL_CARE', 'CONSUMABLE', 'OTHER')),
  brand_name              TEXT,
  generic_name            TEXT,
  composition             TEXT,
  dosage_form             TEXT,
  strength                TEXT,
  pack_size               TEXT,
  base_unit               TEXT DEFAULT 'strip',
  sale_unit               TEXT DEFAULT 'strip',
  conversion_factor       NUMERIC DEFAULT 1.0,
  manufacturer            TEXT,
  marketer                TEXT,
  category                TEXT DEFAULT 'tablet',
  category_id             UUID,
  subcategory_id          UUID,
  hsn_code                TEXT DEFAULT '3004',
  gst_rate                NUMERIC DEFAULT 12.0,
  primary_barcode         TEXT,
  low_stock_threshold     INTEGER DEFAULT 10,
  is_schedule_h1          BOOLEAN DEFAULT false,
  prescription_required   BOOLEAN DEFAULT false,
  schedule_classification TEXT DEFAULT 'NONE' CHECK (schedule_classification IN ('NONE', 'SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X', 'NARCOTIC')),
  cold_chain_required     BOOLEAN DEFAULT false,
  storage_instructions    TEXT,
  minimum_margin_percent  NUMERIC DEFAULT 0,
  preferred_supplier_id   UUID,
  barcode                 TEXT,
  unit                    TEXT DEFAULT 'strip',
  is_active               BOOLEAN DEFAULT true,
  discontinued_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_medicines_clinic_name    ON medicines(clinic_id, name);
CREATE INDEX IF NOT EXISTS idx_medicines_org_active     ON medicines(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_medicines_generic_name   ON medicines(generic_name);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode        ON medicines(barcode);
CREATE INDEX IF NOT EXISTS idx_medicines_product_type   ON medicines(product_type);

-- ──────────────────────────────────────────
-- PRODUCT BARCODES (MULTI-BARCODE ARCHITECTURE)
-- ──────────────────────────────────────────
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
-- MEDICINE BATCHES (PHYSICAL STOCK)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medicine_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID REFERENCES stores(id) ON DELETE SET NULL,
  clinic_id           UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id         UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  supplier_id         UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_id         UUID,
  batch_number        TEXT NOT NULL,
  expiry_date         DATE NOT NULL,
  quantity_in         INTEGER NOT NULL DEFAULT 0,
  quantity_remaining  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_remaining >= 0),
  purchase_price      NUMERIC NOT NULL,
  mrp                 NUMERIC NOT NULL,
  is_disposed         BOOLEAN DEFAULT false,
  disposal_reason     TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_batches_med_expiry      ON medicine_batches(medicine_id, expiry_date ASC);
CREATE INDEX IF NOT EXISTS idx_batches_clinic_disposed ON medicine_batches(clinic_id, is_disposed);
CREATE INDEX IF NOT EXISTS idx_batches_batch_num       ON medicine_batches(batch_number);
CREATE INDEX IF NOT EXISTS idx_batches_store           ON medicine_batches(store_id, medicine_id);

-- ──────────────────────────────────────────
-- INVENTORY POSITIONS (Per-Location Position Abstraction)
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
-- SALES (INVOICES)
-- ──────────────────────────────────────────
-- ──────────────────────────────────────────
-- SALES (INVOICES)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE SET NULL,
  counter_id        UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id       UUID REFERENCES terminals(id) ON DELETE SET NULL,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_number    TEXT NOT NULL,
  subtotal          NUMERIC NOT NULL DEFAULT 0,
  discount          NUMERIC NOT NULL DEFAULT 0,
  gst_amount        NUMERIC NOT NULL DEFAULT 0,
  net_amount        NUMERIC NOT NULL DEFAULT 0,
  grand_total       NUMERIC NOT NULL DEFAULT 0,
  paid_amount       NUMERIC NOT NULL DEFAULT 0,
  balance_due       NUMERIC NOT NULL DEFAULT 0,
  payment_mode      TEXT CHECK (payment_mode IN ('cash','upi','card','credit','mixed')),
  payment_status    TEXT DEFAULT 'paid' CHECK (payment_status IN ('paid','partial','credit','returned')),
  is_return         BOOLEAN DEFAULT false,
  return_of         UUID REFERENCES sales(id),
  served_by         UUID REFERENCES users(id),
  doctor_name       TEXT,
  doctor_registration_number TEXT,
  prescription_number TEXT,
  prescription_url  TEXT,
  prescription_image_url TEXT,
  prescription_required BOOLEAN DEFAULT false,
  idempotency_key   TEXT,
  is_parked         BOOLEAN DEFAULT false,
  park_id           UUID,
  exchange_of_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
  credit_note_number TEXT,
  sale_date         TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sales_clinic_created ON sales(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_store_date     ON sales(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_clinic_invoice ON sales(clinic_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_sales_org_invoice    ON sales(organization_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_sales_customer       ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_idempotency    ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ──────────────────────────────────────────
-- SALE ITEMS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE SET NULL,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  sale_id           UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  medicine_id       UUID NOT NULL REFERENCES medicines(id),
  batch_id          UUID NOT NULL REFERENCES medicine_batches(id),
  quantity          INTEGER NOT NULL,
  unit_type         TEXT DEFAULT 'STRIP',
  conversion_factor NUMERIC DEFAULT 1.0,
  base_quantity     NUMERIC DEFAULT 0,
  mrp_paise         BIGINT DEFAULT 0,
  unit_price_paise  BIGINT DEFAULT 0,
  discount_amount_paise BIGINT DEFAULT 0,
  taxable_amount_paise BIGINT DEFAULT 0,
  tax_amount_paise  BIGINT DEFAULT 0,
  schedule_type     TEXT DEFAULT 'NONE',
  is_prescription_required BOOLEAN DEFAULT false,
  unit_price        NUMERIC NOT NULL,
  discount_pct      NUMERIC DEFAULT 0,
  gst_rate          NUMERIC NOT NULL DEFAULT 12,
  total             NUMERIC NOT NULL,
  reason            TEXT,
  sale_item_id      UUID,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id   ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_batch_id  ON sale_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_store     ON sale_items(store_id);

-- ──────────────────────────────────────────
-- SALE BATCH ALLOCATIONS (FEFO Multi-Batch Traceability)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_batch_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID REFERENCES stores(id) ON DELETE SET NULL,
  sale_id             UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id        UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  medicine_id         UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  batch_id            UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE RESTRICT,
  allocated_quantity  NUMERIC NOT NULL,
  base_quantity       NUMERIC NOT NULL,
  unit_type           TEXT NOT NULL DEFAULT 'STRIP',
  unit_price          NUMERIC NOT NULL,
  cost_price          NUMERIC DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_sale ON sale_batch_allocations(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_item ON sale_batch_allocations(sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_batch_alloc_batch ON sale_batch_allocations(batch_id);

-- ──────────────────────────────────────────
-- PAYMENT TRANSACTIONS (Multi-Tender Normalized Payments)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID REFERENCES stores(id) ON DELETE SET NULL,
  terminal_id         UUID REFERENCES terminals(id) ON DELETE SET NULL,
  sale_id             UUID REFERENCES sales(id) ON DELETE CASCADE,
  return_id           UUID REFERENCES sales(id) ON DELETE CASCADE,
  tender_type         TEXT NOT NULL DEFAULT 'CASH' CHECK (tender_type IN ('CASH', 'UPI', 'CARD', 'CREDIT', 'WALLET', 'LOYALTY', 'VOUCHER', 'OTHER')),
  amount              NUMERIC NOT NULL,
  amount_paise        BIGINT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  reference_number    TEXT,
  status              TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'VOIDED')),
  provider            TEXT,
  change_returned_paise BIGINT NOT NULL DEFAULT 0,
  metadata            JSONB DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_sale ON payment_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_org_store ON payment_transactions(organization_id, store_id, tender_type, created_at);

-- ──────────────────────────────────────────
-- PARKED SALES (Hold / Park / Resume Engine)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parked_sales (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  counter_id          UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id         UUID REFERENCES terminals(id) ON DELETE SET NULL,
  cashier_id          UUID NOT NULL,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  park_token          TEXT NOT NULL,
  cart_snapshot       JSONB NOT NULL DEFAULT '[]'::jsonb,
  customer_snapshot   JSONB DEFAULT '{}'::jsonb,
  totals_snapshot     JSONB DEFAULT '{}'::jsonb,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'PARKED' CHECK (status IN ('PARKED', 'RESUMED', 'CANCELLED', 'EXPIRED', 'COMPLETED')),
  resumed_at          TIMESTAMPTZ,
  resumed_counter_id  UUID REFERENCES counters(id) ON DELETE SET NULL,
  resumed_terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
  resumed_by          UUID,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_parked_sales_org_store ON parked_sales(organization_id, store_id, status);
CREATE INDEX IF NOT EXISTS idx_parked_sales_token ON parked_sales(store_id, park_token);

-- ──────────────────────────────────────────
-- SUPERVISOR AUTHORIZATIONS (Manager Overrides & Audit)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supervisor_authorizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id           TEXT UNIQUE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  counter_id          UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id         UUID REFERENCES terminals(id) ON DELETE SET NULL,
  action_type         TEXT NOT NULL CHECK (action_type IN ('HIGH_DISCOUNT', 'PRICE_OVERRIDE', 'NEAR_EXPIRY_SALE', 'RETURN_OVERRIDE', 'SALE_CANCELLATION', 'BATCH_OVERRIDE')),
  requesting_user_id  UUID NOT NULL,
  authorizing_user_id UUID NOT NULL,
  entity_type         TEXT,
  entity_id           TEXT,
  reason              TEXT NOT NULL,
  old_value           TEXT,
  new_value           TEXT,
  status              TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'REJECTED', 'PENDING')),
  created_at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supervisor_auth_org_store ON supervisor_authorizations(organization_id, store_id, action_type, created_at);

-- ──────────────────────────────────────────
-- PURCHASES & PURCHASE ITEMS
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE SET NULL,
  counter_id        UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id       UUID REFERENCES terminals(id) ON DELETE SET NULL,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  supplier_id       UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  bill_number       TEXT,
  invoice_number    TEXT,
  invoice_date      DATE,
  bill_image_url    TEXT,
  subtotal          NUMERIC NOT NULL DEFAULT 0,
  discount          NUMERIC DEFAULT 0,
  gst_amount        NUMERIC NOT NULL DEFAULT 0,
  net_amount        NUMERIC NOT NULL DEFAULT 0,
  grand_total       NUMERIC NOT NULL DEFAULT 0,
  paid_amount       NUMERIC NOT NULL DEFAULT 0,
  payment_status    TEXT DEFAULT 'unpaid' CHECK (payment_status IN ('paid','partial','unpaid')),
  notes             TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_purchases_clinic_date ON purchases(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_store_date  ON purchases(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE SET NULL,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  purchase_id       UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  medicine_id       UUID NOT NULL REFERENCES medicines(id),
  batch_number      TEXT NOT NULL,
  expiry_date       DATE NOT NULL,
  quantity          INTEGER NOT NULL,
  purchase_price    NUMERIC NOT NULL,
  mrp               NUMERIC NOT NULL,
  gst_rate          NUMERIC NOT NULL DEFAULT 12,
  discount          NUMERIC DEFAULT 0,
  total             NUMERIC NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purch ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_store ON purchase_items(store_id);

-- ──────────────────────────────────────────
-- EXPENSES
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id) ON DELETE SET NULL,
  counter_id        UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id       UUID REFERENCES terminals(id) ON DELETE SET NULL,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN ('rent','salary','utilities','supplies','maintenance','misc')),
  amount            NUMERIC NOT NULL,
  description       TEXT,
  expense_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_expenses_clinic_date ON expenses(clinic_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_store_date  ON expenses(store_id, expense_date DESC);

-- ──────────────────────────────────────────
-- SHORTBOOK (OUT-OF-STOCK ORDER QUEUE)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shortbook (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id         TEXT UNIQUE,
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id       UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  quantity_needed   INTEGER DEFAULT 10,
  reason            TEXT DEFAULT 'low_stock',
  is_ordered        BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shortbook_clinic ON shortbook(clinic_id, is_ordered);

-- ──────────────────────────────────────────
-- STOCK LEDGER (IMMUTABLE MOVEMENT AUDIT - EXTENDED)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_ledger (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                 TEXT UNIQUE,
  organization_id           UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id                  UUID REFERENCES stores(id) ON DELETE SET NULL,
  warehouse_id              UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  clinic_id                 UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id               UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id                  UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  movement_type             TEXT NOT NULL CHECK (
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
                            ),
  quantity_delta            INTEGER NOT NULL,
  balance_after             INTEGER,
  reference_id              TEXT,
  source_location_type      TEXT,
  source_location_id        UUID,
  destination_location_type TEXT,
  destination_location_id   UUID,
  counter_id                UUID REFERENCES counters(id) ON DELETE SET NULL,
  terminal_id               UUID REFERENCES terminals(id) ON DELETE SET NULL,
  notes                     TEXT,
  performed_by              UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_clinic_time ON stock_ledger(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_time  ON stock_ledger(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_med_time    ON stock_ledger(medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_store_batch ON stock_ledger(store_id, batch_id);

-- ──────────────────────────────────────────
-- BACKWARD COMPATIBILITY VIEWS
-- ──────────────────────────────────────────
CREATE OR REPLACE VIEW products           AS SELECT * FROM medicines;
CREATE OR REPLACE VIEW inventory_batches   AS SELECT * FROM medicine_batches;
CREATE OR REPLACE VIEW patients           AS SELECT * FROM customers;
CREATE OR REPLACE VIEW invoices           AS SELECT * FROM sales;
CREATE OR REPLACE VIEW invoice_items      AS SELECT * FROM sale_items;

-- ──────────────────────────────────────────
-- ENTERPRISE COMMERCIAL ENGINE TABLES
-- ──────────────────────────────────────────

-- Price Books
CREATE TABLE IF NOT EXISTS price_books (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  currency              TEXT DEFAULT 'INR',
  priority              INTEGER DEFAULT 10,
  status                TEXT DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'EXPIRED')),
  scope                 TEXT DEFAULT 'ORGANIZATION' CHECK (scope IN ('ORGANIZATION', 'REGION', 'STORE', 'CUSTOMER_GROUP', 'CHANNEL')),
  is_default            BOOLEAN DEFAULT false,
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  created_by            UUID,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_price_books_org_status ON price_books (organization_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_price_books_dates ON price_books (start_at, end_at);

CREATE TABLE IF NOT EXISTS price_book_scopes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  price_book_id         UUID NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  scope_type            TEXT NOT NULL CHECK (scope_type IN ('ORGANIZATION', 'REGION', 'STORE', 'CUSTOMER_GROUP', 'CHANNEL')),
  scope_id              TEXT NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pb_scopes_lookup ON price_book_scopes (organization_id, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS price_book_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  price_book_id         UUID NOT NULL REFERENCES price_books(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  unit_type             TEXT DEFAULT 'STRIP',
  mrp_paise             BIGINT NOT NULL,
  selling_price_paise   BIGINT NOT NULL,
  min_price_paise       BIGINT DEFAULT 0,
  max_discount_pct      NUMERIC DEFAULT 100.0,
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pb_items_lookup ON price_book_items (price_book_id, medicine_id, is_active);

-- Customer Groups & Memberships
CREATE TABLE IF NOT EXISTS customer_groups (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  priority              INTEGER DEFAULT 10,
  default_price_book_id UUID REFERENCES price_books(id) ON DELETE SET NULL,
  discount_pct          NUMERIC DEFAULT 0.0,
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_customer_groups_org ON customer_groups (organization_id, is_active, priority DESC);

CREATE TABLE IF NOT EXISTS customer_group_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_group_id     UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  status                TEXT DEFAULT 'ACTIVE',
  assigned_by           UUID,
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cgm_cust ON customer_group_members (customer_id, status);

CREATE TABLE IF NOT EXISTS customer_memberships (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  membership_number     TEXT,
  membership_type       TEXT DEFAULT 'STANDARD',
  tier                  TEXT DEFAULT 'SILVER',
  loyalty_multiplier    NUMERIC DEFAULT 1.0,
  start_at              TIMESTAMPTZ DEFAULT now(),
  end_at                TIMESTAMPTZ,
  status                TEXT DEFAULT 'ACTIVE',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memberships_cust ON customer_memberships (customer_id, status);

-- Promotions
CREATE TABLE IF NOT EXISTS promotions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  promotion_type        TEXT NOT NULL,
  priority              INTEGER DEFAULT 10,
  stackability          TEXT DEFAULT 'STACKABLE',
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  status                TEXT DEFAULT 'ACTIVE',
  usage_limit           INTEGER,
  per_customer_limit    INTEGER,
  current_uses          INTEGER DEFAULT 0,
  channel_scope         TEXT DEFAULT 'ALL',
  min_cart_value_paise  BIGINT DEFAULT 0,
  max_discount_paise    BIGINT,
  is_best_offer_eligible BOOLEAN DEFAULT true,
  rule_version          INTEGER DEFAULT 1,
  config_json           JSONB DEFAULT '{}'::jsonb,
  created_by            UUID,
  approved_by           UUID,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_promotions_org_status ON promotions (organization_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS promotion_targets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  promotion_id          UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  target_type           TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  is_excluded           BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotion_rewards (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  promotion_id          UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  reward_type           TEXT NOT NULL,
  reward_value          NUMERIC DEFAULT 0,
  reward_medicine_id    UUID REFERENCES medicines(id) ON DELETE SET NULL,
  reward_quantity       NUMERIC DEFAULT 0,
  max_reward_value_paise BIGINT,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotion_applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE SET NULL,
  sale_id               UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  promotion_id          UUID NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
  promotion_code        TEXT NOT NULL,
  promotion_name        TEXT NOT NULL,
  discount_amount_paise BIGINT DEFAULT 0,
  free_quantity         NUMERIC DEFAULT 0,
  reward_medicine_id    UUID REFERENCES medicines(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promo_apps_sale ON promotion_applications (sale_id);

-- Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  campaign_name         TEXT,
  promotion_id          UUID REFERENCES promotions(id) ON DELETE SET NULL,
  coupon_type           TEXT DEFAULT 'PUBLIC',
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  discount_type         TEXT DEFAULT 'FLAT',
  discount_value        NUMERIC DEFAULT 0,
  min_spend_paise       BIGINT DEFAULT 0,
  max_discount_paise    BIGINT,
  max_uses              INTEGER,
  max_uses_per_customer INTEGER DEFAULT 1,
  current_uses          INTEGER DEFAULT 0,
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  status                TEXT DEFAULT 'ACTIVE',
  is_active             BOOLEAN DEFAULT true,
  is_stackable          BOOLEAN DEFAULT true,
  eligible_stores       JSONB DEFAULT '[]'::jsonb,
  eligible_products     JSONB DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  _deleted              SMALLINT DEFAULT 0,
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_coupons_lookup ON coupons (organization_id, code, is_active);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  coupon_id             UUID NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  sale_id               UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  discount_amount_paise BIGINT NOT NULL,
  redeemed_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_sale ON coupon_redemptions (sale_id);

-- Loyalty
CREATE TABLE IF NOT EXISTS loyalty_programs (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id                       TEXT UNIQUE,
  organization_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                            TEXT NOT NULL,
  earn_rate_spend_paise           BIGINT DEFAULT 10000,
  credits_per_earn_unit           NUMERIC DEFAULT 1.0,
  redemption_rate_paise_per_credit BIGINT DEFAULT 25,
  min_redemption_credits          INTEGER DEFAULT 50,
  max_redemption_pct              NUMERIC DEFAULT 50.0,
  credit_expiry_days              INTEGER DEFAULT 365,
  exclude_taxes_from_earn         BOOLEAN DEFAULT true,
  exclude_discounted_items        BOOLEAN DEFAULT false,
  status                          TEXT DEFAULT 'ACTIVE',
  is_active                       BOOLEAN DEFAULT true,
  created_at                      TIMESTAMPTZ DEFAULT now(),
  updated_at                      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  program_id            UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE RESTRICT,
  available_balance     NUMERIC DEFAULT 0,
  pending_balance       NUMERIC DEFAULT 0,
  lifetime_earned       NUMERIC DEFAULT 0,
  lifetime_redeemed     NUMERIC DEFAULT 0,
  status                TEXT DEFAULT 'ACTIVE',
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (organization_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_acc_cust ON loyalty_accounts (customer_id);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  return_id             UUID REFERENCES sales(id) ON DELETE SET NULL,
  transaction_type      TEXT NOT NULL,
  credits               NUMERIC NOT NULL,
  credits_balance_after NUMERIC NOT NULL,
  monetary_value_paise  BIGINT DEFAULT 0,
  notes                 TEXT,
  idempotency_key       TEXT,
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_acc ON loyalty_transactions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_sale ON loyalty_transactions (sale_id);

-- Supplier Schemes
CREATE TABLE IF NOT EXISTS supplier_schemes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id           UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  scheme_type           TEXT NOT NULL,
  medicine_id           UUID REFERENCES medicines(id) ON DELETE SET NULL,
  category_id           UUID,
  manufacturer          TEXT,
  min_quantity          NUMERIC DEFAULT 1,
  free_quantity         NUMERIC DEFAULT 0,
  discount_pct          NUMERIC DEFAULT 0.0,
  flat_discount_paise   BIGINT DEFAULT 0,
  scheme_credit_paise   BIGINT DEFAULT 0,
  start_at              TIMESTAMPTZ,
  end_at                TIMESTAMPTZ,
  status                TEXT DEFAULT 'ACTIVE',
  priority              INTEGER DEFAULT 10,
  config_json           JSONB DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_schemes_lookup ON supplier_schemes (organization_id, supplier_id, status);

-- Sale Commercial Snapshots
CREATE TABLE IF NOT EXISTS sale_commercial_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE SET NULL,
  sale_id               UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  mrp_total_paise       BIGINT NOT NULL,
  base_total_paise      BIGINT NOT NULL,
  promo_discount_paise  BIGINT DEFAULT 0,
  coupon_discount_paise BIGINT DEFAULT 0,
  member_discount_paise BIGINT DEFAULT 0,
  manual_discount_paise BIGINT DEFAULT 0,
  loyalty_redeemed_paise BIGINT DEFAULT 0,
  loyalty_earned_credits NUMERIC DEFAULT 0,
  total_savings_paise   BIGINT DEFAULT 0,
  gross_margin_paise    BIGINT DEFAULT 0,
  gross_margin_pct      NUMERIC DEFAULT 0.0,
  applied_rules_json    JSONB DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (sale_id)
);
CREATE INDEX IF NOT EXISTS idx_sale_comm_snap_sale ON sale_commercial_snapshots (sale_id);

-- ──────────────────────────────────────────
-- TASK 4: PRESCRIPTION MANAGEMENT & SAFETY ENGINE
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS doctors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  registration_number   TEXT NOT NULL,
  registration_authority TEXT,
  specialization        TEXT,
  phone                 TEXT,
  clinic_hospital       TEXT,
  address               TEXT,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctors_org_name ON doctors(organization_id, name);

CREATE TABLE IF NOT EXISTS prescriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE SET NULL,
  patient_id            UUID REFERENCES customers(id) ON DELETE SET NULL,
  prescription_number   TEXT NOT NULL,
  external_rx_number    TEXT,
  doctor_id             UUID REFERENCES doctors(id) ON DELETE SET NULL,
  doctor_name_snapshot  TEXT NOT NULL,
  doctor_registration_number_snapshot TEXT NOT NULL,
  prescribed_at         TIMESTAMPTZ DEFAULT now(),
  valid_from            TIMESTAMPTZ DEFAULT now(),
  valid_until           TIMESTAMPTZ,
  document_url          TEXT NOT NULL,
  document_hash         TEXT,
  source                TEXT DEFAULT 'FILE_UPLOAD',
  status                TEXT DEFAULT 'NEEDS_REVIEW',
  verification_status   TEXT DEFAULT 'UNVERIFIED',
  verified_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at           TIMESTAMPTZ,
  assigned_to           UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  notes                 TEXT,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_org_status ON prescriptions(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS prescription_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  prescription_id       UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  sequence              INTEGER DEFAULT 1,
  raw_text              TEXT NOT NULL,
  matched_product_id    UUID REFERENCES medicines(id) ON DELETE SET NULL,
  generic_name          TEXT,
  prescribed_name       TEXT NOT NULL,
  strength              TEXT,
  dosage_form           TEXT,
  dose_text             TEXT,
  frequency_text        TEXT,
  duration_text         TEXT,
  prescribed_quantity   INTEGER DEFAULT 1,
  dispensed_quantity    INTEGER DEFAULT 0,
  repeats_authorized    INTEGER DEFAULT 0,
  repeats_used          INTEGER DEFAULT 0,
  repeat_interval_days  INTEGER,
  repeats_valid_until   TIMESTAMPTZ,
  substitution_allowed  BOOLEAN DEFAULT TRUE,
  notes                 TEXT,
  match_status          TEXT DEFAULT 'UNMATCHED',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rx_items_rx_id ON prescription_items(prescription_id);

CREATE TABLE IF NOT EXISTS dispensing_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  terminal_id           UUID REFERENCES terminals(id) ON DELETE SET NULL,
  prescription_id       UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  prescription_item_id  UUID NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
  sale_id               UUID REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id          UUID REFERENCES sale_items(id) ON DELETE CASCADE,
  product_id            UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
  quantity_dispensed    INTEGER NOT NULL,
  base_unit_quantity    INTEGER DEFAULT 1,
  dispensed_by          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dispensed_at          TIMESTAMPTZ DEFAULT now(),
  created_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispensing_rx_id ON dispensing_events(prescription_id);

CREATE TABLE IF NOT EXISTS patient_allergies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id            UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  allergen              TEXT NOT NULL,
  allergen_type         TEXT DEFAULT 'INGREDIENT',
  reaction_text         TEXT,
  severity              TEXT DEFAULT 'MODERATE',
  recorded_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  source                TEXT DEFAULT 'MANUAL_ENTRY',
  active                BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_warning_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE SET NULL,
  prescription_id       UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  warning_type          TEXT NOT NULL,
  severity              TEXT NOT NULL,
  warning_text          TEXT NOT NULL,
  acknowledged_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at       TIMESTAMPTZ DEFAULT now(),
  action_taken          TEXT,
  reason                TEXT,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS substitution_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prescription_id       UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  prescription_item_id  UUID NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  prescribed_product_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
  prescribed_name       TEXT NOT NULL,
  dispensed_product_id  UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  dispensed_name        TEXT NOT NULL,
  substituted_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason                TEXT NOT NULL,
  customer_confirmed    BOOLEAN DEFAULT FALSE,
  doctor_confirmed      BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- ──────────────────────────────────────────
-- TASK 5: ADVANCED INVENTORY INTELLIGENCE, STOCKTAKE, RECALL & RESERVATIONS
-- ──────────────────────────────────────────

-- Multi-state breakdown columns on inventory_positions
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_quarantined NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_damaged NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_recalled NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_on_hold NUMERIC(15, 4) DEFAULT 0;
ALTER TABLE inventory_positions ADD COLUMN IF NOT EXISTS quantity_stocktake_locked NUMERIC(15, 4) DEFAULT 0;

CREATE TABLE IF NOT EXISTS stocktake_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'FULL',
  scope                 JSONB DEFAULT '{}',
  counting_mode         TEXT NOT NULL DEFAULT 'LIVE_COUNT',
  is_blind_count        BOOLEAN DEFAULT FALSE,
  is_double_count       BOOLEAN DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'DRAFT',
  initiated_by          TEXT NOT NULL,
  approved_by           TEXT,
  reference_timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktake_org_store ON stocktake_sessions(organization_id, store_id, status);

CREATE TABLE IF NOT EXISTS stocktake_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  stocktake_id          UUID NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  batch_number          TEXT,
  expiry_date           TEXT,
  expected_quantity     NUMERIC(15, 4) NOT NULL DEFAULT 0,
  physical_quantity     NUMERIC(15, 4) NOT NULL DEFAULT 0,
  difference            NUMERIC(15, 4) NOT NULL DEFAULT 0,
  unit_cost_paise       BIGINT NOT NULL DEFAULT 0,
  value_difference_paise BIGINT NOT NULL DEFAULT 0,
  variance_reason       TEXT,
  recount_status        TEXT DEFAULT 'NONE',
  recount_count_a       NUMERIC(15, 4),
  recount_count_b       NUMERIC(15, 4),
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id, medicine_id);

CREATE TABLE IF NOT EXISTS stocktake_counts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  stocktake_id          UUID NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
  stocktake_item_id     UUID REFERENCES stocktake_items(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  counter_name          TEXT,
  user_id               TEXT NOT NULL,
  scanned_barcode       TEXT,
  raw_quantity          NUMERIC(15, 4) NOT NULL DEFAULT 1,
  unit_type             TEXT DEFAULT 'BASE',
  conversion_factor     NUMERIC(15, 4) DEFAULT 1,
  base_quantity         NUMERIC(15, 4) NOT NULL DEFAULT 1,
  device_id             TEXT,
  is_offline_sync       BOOLEAN DEFAULT FALSE,
  counted_at            TIMESTAMPTZ DEFAULT now(),
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_recalls (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recall_reference      TEXT NOT NULL,
  recall_type           TEXT NOT NULL DEFAULT 'BATCH',
  product_id            UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  batch_number          TEXT,
  manufacturer          TEXT,
  reason                TEXT NOT NULL,
  severity              TEXT DEFAULT 'CLASS_I',
  status                TEXT NOT NULL DEFAULT 'DRAFT',
  initiated_at          TIMESTAMPTZ DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  created_by            TEXT NOT NULL,
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recalls_org_prod ON product_recalls(organization_id, product_id, status);

CREATE TABLE IF NOT EXISTS recall_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  recall_id             UUID NOT NULL REFERENCES product_recalls(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  location_type         TEXT NOT NULL,
  expected_units        NUMERIC(15, 4) NOT NULL DEFAULT 0,
  quarantined_units     NUMERIC(15, 4) NOT NULL DEFAULT 0,
  discrepancy_units     NUMERIC(15, 4) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  assigned_to           TEXT,
  completed_by          TEXT,
  completed_at          TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_type         TEXT NOT NULL,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  quantity              NUMERIC(15, 4) NOT NULL,
  source_type           TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by            TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_alerts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  medicine_id           UUID REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id              UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  alert_type            TEXT NOT NULL,
  severity              TEXT NOT NULL DEFAULT 'WARNING',
  title                 TEXT NOT NULL,
  message               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'OPEN',
  acknowledged_by       TEXT,
  acknowledged_at       TIMESTAMPTZ,
  metadata              JSONB DEFAULT '{}',
  dedup_key             TEXT UNIQUE,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stockout_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at              TIMESTAMPTZ,
  duration_hours        NUMERIC(10, 2),
  estimated_lost_demand NUMERIC(15, 4) DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_classifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id             TEXT UNIQUE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id              UUID REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  medicine_id           UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  abc_class             TEXT DEFAULT 'C',
  movement_class        TEXT DEFAULT 'NORMAL',
  avg_daily_sales_7d    NUMERIC(15, 4) DEFAULT 0,
  avg_daily_sales_30d   NUMERIC(15, 4) DEFAULT 0,
  avg_daily_sales_90d   NUMERIC(15, 4) DEFAULT 0,
  days_of_stock_cover   NUMERIC(15, 2) DEFAULT 0,
  last_sale_date        TIMESTAMPTZ,
  days_since_last_sale  INTEGER DEFAULT 0,
  total_sales_units_90d NUMERIC(15, 4) DEFAULT 0,
  total_sales_value_paise_90d BIGINT DEFAULT 0,
  computed_at           TIMESTAMPTZ DEFAULT now(),
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);


