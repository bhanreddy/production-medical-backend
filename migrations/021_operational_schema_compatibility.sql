-- Preserve the single-clinic fields used by the operational API on installations
-- initialized from the enterprise schema. Existing values are never overwritten.
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS signature_url TEXT,
  ADD COLUMN IF NOT EXISTS invoice_footer TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS drug_licence_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_purchases NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_purchase_date DATE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS recorded_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shortbook ADD COLUMN IF NOT EXISTS preferred_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ;
