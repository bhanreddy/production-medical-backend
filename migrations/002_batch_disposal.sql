-- Batch write-off / disposal (soft — row retained, excluded from sellable stock)

ALTER TABLE medicine_batches
  ADD COLUMN IF NOT EXISTS is_disposed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disposed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disposed_by uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS disposal_reason text,
  ADD COLUMN IF NOT EXISTS disposal_notes text;

CREATE INDEX IF NOT EXISTS idx_medicine_batches_clinic_active
  ON medicine_batches (clinic_id, is_disposed)
  WHERE deleted_at IS NULL AND (is_disposed = false OR is_disposed IS NULL);

CREATE INDEX IF NOT EXISTS idx_medicine_batches_clinic_disposed
  ON medicine_batches (clinic_id, disposed_at DESC)
  WHERE deleted_at IS NULL AND is_disposed = true;
