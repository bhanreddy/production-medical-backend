-- Phase 7–9: barcode, invoice sequence, medicine master, customer GSTIN, broadcast log, optional dashboard MV, verification helpers
-- Apply in Supabase SQL editor or via migration pipeline.

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS barcode text;
CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines (clinic_id, barcode) WHERE barcode IS NOT NULL;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS gstin text;

CREATE TABLE IF NOT EXISTS clinic_invoice_sequences (
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  sequence_date date NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (clinic_id, sequence_date)
);

CREATE OR REPLACE FUNCTION next_clinic_invoice_seq (p_clinic_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v integer;
BEGIN
  INSERT INTO clinic_invoice_sequences (clinic_id, sequence_date, last_value)
  VALUES (p_clinic_id, p_day, 1)
  ON CONFLICT (clinic_id, sequence_date)
  DO UPDATE SET last_value = clinic_invoice_sequences.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END;
$$;

CREATE TABLE IF NOT EXISTS medicine_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  generic_name text,
  manufacturer text,
  category text,
  hsn_code text,
  gst_rate numeric DEFAULT 0,
  schedule text,
  barcode text,
  unit text DEFAULT 'strip',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE medicine_master DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_medicine_master_search ON medicine_master USING gin (
  to_tsvector('english', name || ' ' || COALESCE(generic_name, ''))
);

CREATE INDEX IF NOT EXISTS idx_medicine_master_barcode ON medicine_master (barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_broadcast_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  template_name text NOT NULL,
  recipient_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_broadcast_clinic_time ON whatsapp_broadcast_log (clinic_id, created_at DESC);

DROP MATERIALIZED VIEW IF EXISTS daily_sales_summary;

CREATE MATERIALIZED VIEW daily_sales_summary AS
SELECT
  s.clinic_id,
  (s.sale_date AT TIME ZONE 'UTC')::date AS sale_day,
  COUNT(*) AS bill_count,
  SUM(s.net_amount) AS revenue,
  SUM(s.gst_amount) AS gst_total,
  AVG(s.net_amount) AS avg_basket,
  COUNT(DISTINCT s.customer_id) AS unique_customers
FROM sales s
WHERE s.is_return = false
GROUP BY s.clinic_id, (s.sale_date AT TIME ZONE 'UTC')::date;

CREATE UNIQUE INDEX idx_daily_sales_summary_pk ON daily_sales_summary (clinic_id, sale_day);

-- Refresh (schedule with pg_cron when ready):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales_summary;
