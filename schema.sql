-- schema.sql (single source of truth)

-- CLINICS
CREATE TABLE clinics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  address         TEXT,
  phone           TEXT,
  gstin           TEXT,
  subscription_id TEXT,                -- Razorpay subscription ID
  plan            TEXT DEFAULT 'trial' CHECK (plan IN ('trial','basic','pro')),
  trial_ends_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- CLINIC USERS
CREATE TABLE clinic_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,           -- bcrypt hashed
  role        TEXT NOT NULL CHECK (role IN ('owner','doctor','pharmacist','receptionist')),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- PATIENTS
CREATE TABLE patients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  name        TEXT NOT NULL,
  phone       TEXT,
  dob         DATE,
  gender      TEXT CHECK (gender IN ('male','female','other')),
  address     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_patients_clinic_phone ON patients(clinic_id, phone);
CREATE INDEX idx_patients_clinic_name  ON patients(clinic_id, name);

-- PRODUCT CATEGORIES
CREATE TABLE categories (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  name      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- PRODUCTS (master catalog)
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  category_id   UUID REFERENCES categories(id),
  name          TEXT NOT NULL,
  generic_name  TEXT,
  barcode       TEXT,
  unit          TEXT DEFAULT 'strip',
  hsn_code      TEXT,
  gst_rate      INTEGER DEFAULT 12,  -- percentage (5, 12, 18)
  reorder_level INTEGER DEFAULT 10,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_products_clinic   ON products(clinic_id);
CREATE INDEX idx_products_barcode  ON products(barcode);

-- INVENTORY BATCHES (FIFO source)
CREATE TABLE inventory_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id),
  product_id      UUID NOT NULL REFERENCES products(id),
  batch_number    TEXT NOT NULL,
  expiry_date     DATE NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 0,  -- remaining units
  purchase_price  INTEGER NOT NULL,             -- paise per unit
  selling_price   INTEGER NOT NULL,             -- paise per unit (MRP)
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_batches_product_expiry ON inventory_batches(product_id, expiry_date ASC);

-- INVENTORY TRANSACTIONS (audit log)
CREATE TABLE inventory_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  product_id        UUID NOT NULL REFERENCES products(id),
  batch_id          UUID NOT NULL REFERENCES inventory_batches(id),
  type              TEXT NOT NULL CHECK (type IN ('purchase','sale','adjustment','return')),
  quantity_delta    INTEGER NOT NULL,   -- negative for sales
  invoice_id        UUID,               -- FK to invoices (set for sale type)
  idempotency_key   TEXT UNIQUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- INVOICES
CREATE TABLE invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  patient_id        UUID REFERENCES patients(id),
  invoice_number    TEXT NOT NULL,
  status            TEXT DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled')),
  subtotal          INTEGER NOT NULL DEFAULT 0,  -- paise
  discount          INTEGER NOT NULL DEFAULT 0,  -- paise
  gst_amount        INTEGER NOT NULL DEFAULT 0,  -- paise
  total             INTEGER NOT NULL DEFAULT 0,  -- paise
  payment_method    TEXT CHECK (payment_method IN ('cash','upi','card','credit')),
  payment_status    TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','partial')),
  idempotency_key   TEXT UNIQUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX idx_invoices_clinic_date ON invoices(clinic_id, created_at DESC);

-- INVOICE LINE ITEMS
CREATE TABLE invoice_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id),
  batch_id        UUID NOT NULL REFERENCES inventory_batches(id),
  quantity        INTEGER NOT NULL,
  unit_price      INTEGER NOT NULL,   -- paise (selling price at time of sale)
  discount        INTEGER DEFAULT 0,  -- paise
  gst_rate        INTEGER NOT NULL,
  gst_amount      INTEGER NOT NULL,   -- paise
  total           INTEGER NOT NULL,   -- paise
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- PRESCRIPTIONS
CREATE TABLE prescriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  patient_id  UUID NOT NULL REFERENCES patients(id),
  doctor_name TEXT,
  notes       TEXT,
  invoice_id  UUID REFERENCES invoices(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
