-- ============================================================================
-- MIGRATION 005: SCHEMA CANONICALIZATION, STOCK LEDGER & COMPATIBILITY VIEWS
-- ============================================================================
-- Establishes canonical domain tables (medicines, medicine_batches, customers,
-- sales, sale_items, purchases, purchase_items, stock_ledger) and provides
-- non-destructive backward-compatibility views for legacy queries (products,
-- inventory_batches, patients, invoices, invoice_items).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. CANONICAL STOCK MOVEMENT LEDGER
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id       TEXT UNIQUE,
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id     UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id        UUID REFERENCES medicine_batches(id) ON DELETE SET NULL,
  movement_type   TEXT NOT NULL CHECK (
                    movement_type IN (
                      'SALE',
                      'SALE_RETURN',
                      'PURCHASE_RECEIPT',
                      'PURCHASE_RETURN',
                      'ADJUSTMENT_PLUS',
                      'ADJUSTMENT_MINUS',
                      'DAMAGE',
                      'EXPIRY',
                      'DISPOSAL',
                      'OPENING_STOCK'
                    )
                  ),
  quantity_delta  INTEGER NOT NULL, -- Negative for sales/damage, positive for purchase/return
  balance_after   INTEGER,          -- Snapshot of remaining stock after this movement
  reference_id    TEXT,             -- ID of associated sale, purchase, or disposal
  notes           TEXT,
  performed_by    UUID,             -- User ID who authorized or performed movement
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Older deployments already have a ledger with qty_change/qty_after columns.
-- CREATE TABLE IF NOT EXISTS alone does not upgrade those installations.
ALTER TABLE stock_ledger
  ADD COLUMN IF NOT EXISTS _local_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS batch_id UUID,
  ADD COLUMN IF NOT EXISTS quantity_delta INTEGER,
  ADD COLUMN IF NOT EXISTS balance_after INTEGER,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS performed_by UUID,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_stock_ledger_clinic_time ON stock_ledger (clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_med_time    ON stock_ledger (medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_batch       ON stock_ledger (batch_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_local_id    ON stock_ledger (_local_id) WHERE _local_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. BACKWARD COMPATIBILITY SYNONYM VIEWS
-- ────────────────────────────────────────────────────────────────────────────
-- Allows legacy endpoints or external tools querying legacy table names
-- to seamlessly read the canonical tables without schema bifurcation.

DO $$
BEGIN
  -- products view -> medicines
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'products') THEN
    CREATE OR REPLACE VIEW products AS SELECT * FROM medicines;
  END IF;

  -- inventory_batches view -> medicine_batches
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'inventory_batches') THEN
    CREATE OR REPLACE VIEW inventory_batches AS SELECT * FROM medicine_batches;
  END IF;

  -- patients view -> customers
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'patients') THEN
    CREATE OR REPLACE VIEW patients AS SELECT * FROM customers;
  END IF;

  -- invoices view -> sales
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'invoices') THEN
    CREATE OR REPLACE VIEW invoices AS SELECT * FROM sales;
  END IF;

  -- invoice_items view -> sale_items
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'invoice_items') THEN
    CREATE OR REPLACE VIEW invoice_items AS SELECT * FROM sale_items;
  END IF;
END
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. STORED PROCEDURE: DAILY SALES SUMMARY REFRESH
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_daily_sales_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales_summary;
  EXCEPTION
    WHEN OTHERS THEN
      REFRESH MATERIALIZED VIEW daily_sales_summary;
  END;
END;
$$;
