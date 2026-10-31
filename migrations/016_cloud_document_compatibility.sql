-- Columns used by the current cloud document writers on older installations.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS grand_total NUMERIC,
  ADD COLUMN IF NOT EXISTS balance_due NUMERIC NOT NULL DEFAULT 0;
UPDATE sales SET grand_total = net_amount WHERE grand_total IS NULL;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS grand_total NUMERIC,
  ADD COLUMN IF NOT EXISTS bill_number TEXT;
UPDATE purchases SET grand_total = net_amount WHERE grand_total IS NULL;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC,
  ADD COLUMN IF NOT EXISTS mrp NUMERIC,
  ADD COLUMN IF NOT EXISTS sale_item_id UUID,
  ADD COLUMN IF NOT EXISTS reason TEXT;
UPDATE sale_items SET unit_price = mrp WHERE unit_price IS NULL;
-- Keep the original mandatory MRP field populated by both sale and return writers.
CREATE OR REPLACE FUNCTION sale_item_price_compatibility() RETURNS trigger AS $$
BEGIN
  NEW.mrp := COALESCE(NEW.mrp, NEW.unit_price);
  NEW.unit_price := COALESCE(NEW.unit_price, NEW.mrp);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_item_price_fields ON sale_items;
CREATE TRIGGER sale_item_price_fields BEFORE INSERT OR UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION sale_item_price_compatibility();
CREATE TABLE IF NOT EXISTS clinic_invoice_sequences (
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  sequence_date DATE NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(clinic_id, sequence_date)
);

ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS cost_price_paise BIGINT;
UPDATE medicine_batches SET cost_price_paise = round(purchase_price * 100) WHERE cost_price_paise IS NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_status_check CHECK (payment_status IN ('paid', 'partial', 'credit', 'returned', 'unpaid'));
