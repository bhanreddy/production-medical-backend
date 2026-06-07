-- Purchase orders used by supplier workflows and batch-disposal safety checks.

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES suppliers (id),
  po_number text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_date date,
  notes text,
  lines_json text NOT NULL DEFAULT '[]',
  _local_id text UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_clinic_status
  ON purchase_orders (clinic_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_updated_at
  ON purchase_orders (updated_at);

