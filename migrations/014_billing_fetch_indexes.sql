-- Speeds up live invoice pagination and customer enrichment.
-- Apply through the normal PostgreSQL migration process after migration 001.
CREATE INDEX IF NOT EXISTS idx_billing_sales_clinic_created
  ON sales (clinic_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_customers_clinic_id
  ON customers (clinic_id, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_customers_clinic_local_id
  ON customers (clinic_id, _local_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_sale_items_medicine
  ON sale_items (medicine_id, sale_id) WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_billing_batch_stock
  ON medicine_batches (clinic_id, medicine_id, expiry_date)
  WHERE deleted_at IS NULL AND quantity_remaining > 0 AND (is_disposed = false OR is_disposed IS NULL);

CREATE INDEX IF NOT EXISTS idx_billing_medicines_clinic
  ON medicines (clinic_id) WHERE deleted_at IS NULL AND is_active = true;
