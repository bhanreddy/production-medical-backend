-- Substring medicine search must not scan the whole catalogue on each keystroke.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_billing_medicine_name_trgm
  ON medicines USING gin (name gin_trgm_ops)
  WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_billing_medicine_generic_trgm
  ON medicines USING gin (generic_name gin_trgm_ops)
  WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_billing_medicine_barcode
  ON medicines (clinic_id, barcode)
  WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_billing_subscription_latest
  ON clinic_subscriptions (clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_daily_usage
  ON sales (clinic_id, sale_date) WHERE is_return = false;
