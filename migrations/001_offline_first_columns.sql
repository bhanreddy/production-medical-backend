-- ==========================================
-- MIGRATION 001: OFFLINE-FIRST SYNC COLUMNS
-- ==========================================
-- Adds _local_id, updated_at, deleted_at to every syncable business table.
-- Adds moddatetime trigger on updated_at for automatic timestamp tracking.
-- Run this ONCE against your Supabase PostgreSQL database.

-- Ensure moddatetime extension is available (ships with Supabase by default)
CREATE EXTENSION IF NOT EXISTS moddatetime;

-- ──────────────────────────────────────────
-- HELPER: reusable function to add offline-first columns + trigger
-- ──────────────────────────────────────────

-- We apply the same 3-column + 1-trigger pattern to every table.
-- _local_id  → client-generated UUID, idempotency key
-- updated_at → auto-updated timestamp for delta sync
-- deleted_at → soft-delete marker (medical audit compliance)

-- ──────────────────────────────────────────
-- TABLE: clinics
-- ──────────────────────────────────────────
ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON clinics;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON clinics
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: suppliers
-- ──────────────────────────────────────────
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON suppliers;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: customers
-- ──────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON customers;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: medicines
-- ──────────────────────────────────────────
ALTER TABLE medicines
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON medicines;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON medicines
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: medicine_batches
-- ──────────────────────────────────────────
ALTER TABLE medicine_batches
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON medicine_batches;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON medicine_batches
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: purchases
-- ──────────────────────────────────────────
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON purchases;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: purchase_items
-- ──────────────────────────────────────────
ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON purchase_items;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: sales
-- ──────────────────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON sales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: sale_items
-- ──────────────────────────────────────────
ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON sale_items;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: expenses
-- ──────────────────────────────────────────
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON expenses;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: shortbook
-- ──────────────────────────────────────────
ALTER TABLE shortbook
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON shortbook;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shortbook
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- TABLE: refill_reminders
-- ──────────────────────────────────────────
ALTER TABLE refill_reminders
  ADD COLUMN IF NOT EXISTS _local_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

DROP TRIGGER IF EXISTS set_updated_at ON refill_reminders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON refill_reminders
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- ──────────────────────────────────────────
-- INDEXES on _local_id for fast sync lookups
-- ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clinics_local_id          ON clinics(_local_id)          WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_local_id        ON suppliers(_local_id)        WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_local_id        ON customers(_local_id)        WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medicines_local_id        ON medicines(_local_id)        WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medicine_batches_local_id ON medicine_batches(_local_id) WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_local_id        ON purchases(_local_id)        WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_items_local_id   ON purchase_items(_local_id)   WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_local_id            ON sales(_local_id)            WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sale_items_local_id       ON sale_items(_local_id)       WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_local_id         ON expenses(_local_id)         WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shortbook_local_id        ON shortbook(_local_id)        WHERE _local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refill_reminders_local_id ON refill_reminders(_local_id) WHERE _local_id IS NOT NULL;

-- ──────────────────────────────────────────
-- INDEXES on updated_at for delta sync pulls
-- ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_suppliers_updated_at        ON suppliers(updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at        ON customers(updated_at);
CREATE INDEX IF NOT EXISTS idx_medicines_updated_at        ON medicines(updated_at);
CREATE INDEX IF NOT EXISTS idx_medicine_batches_updated_at ON medicine_batches(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchases_updated_at        ON purchases(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_items_updated_at   ON purchase_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_updated_at            ON sales(updated_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_updated_at       ON sale_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_expenses_updated_at         ON expenses(updated_at);
CREATE INDEX IF NOT EXISTS idx_shortbook_updated_at        ON shortbook(updated_at);
CREATE INDEX IF NOT EXISTS idx_refill_reminders_updated_at ON refill_reminders(updated_at);
