-- Complete the legacy purchase-return workflow and upgrade older stock ledgers.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS owner_name TEXT;

CREATE TABLE IF NOT EXISTS purchase_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id TEXT UNIQUE,
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_note TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED',
  total_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  _local_id TEXT UNIQUE,
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  return_id UUID NOT NULL REFERENCES purchase_returns(id),
  batch_id UUID NOT NULL REFERENCES medicine_batches(id),
  medicine_id UUID NOT NULL REFERENCES medicines(id),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  rate NUMERIC(14,2) NOT NULL CHECK (rate >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_clinic_date ON purchase_returns(clinic_id, return_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_return_lines_header ON purchase_return_lines(clinic_id, return_id);
-- These tables are accessed through the authenticated, clinic-scoped API.
-- Prevent direct access through anonymous/authenticated Supabase clients.
ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_ledger
  ADD COLUMN IF NOT EXISTS _local_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS batch_id UUID,
  ADD COLUMN IF NOT EXISTS quantity_delta INTEGER,
  ADD COLUMN IF NOT EXISTS balance_after INTEGER,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS performed_by UUID,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Older schemas require these fields. Populate them from the canonical fields
-- for new writes while preserving historical records and their column names.
CREATE OR REPLACE FUNCTION stock_ledger_legacy_compatibility() RETURNS trigger AS $$
BEGIN
  NEW.quantity_delta := COALESCE(NEW.quantity_delta, (to_jsonb(NEW)->>'qty_change')::integer, 0);
  NEW.balance_after := COALESCE(NEW.balance_after, (to_jsonb(NEW)->>'qty_after')::integer);
  NEW.notes := COALESCE(NEW.notes, to_jsonb(NEW)->>'note');
  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'qty_change', COALESCE(NEW.quantity_delta, 0),
    'qty_after', COALESCE(NEW.balance_after, 0),
    'qty_before', COALESCE(NEW.balance_after, 0) - COALESCE(NEW.quantity_delta, 0),
    'note', NEW.notes
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stock_ledger_legacy_fields ON stock_ledger;
CREATE TRIGGER stock_ledger_legacy_fields BEFORE INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_legacy_compatibility();
