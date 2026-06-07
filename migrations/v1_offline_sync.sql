-- v1 offline sync: infrastructure + sync columns on core tables
-- Run against PostgreSQL (Supabase). Idempotent-style adds.

-- ---------------------------------------------------------------------------
-- Sync infrastructure
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  device_id               varchar(36) NOT NULL,
  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  direction               varchar(20) NOT NULL DEFAULT 'BOTH',
  records_pushed          integer NOT NULL DEFAULT 0,
  records_pulled          integer NOT NULL DEFAULT 0,
  conflicts_detected      integer NOT NULL DEFAULT 0,
  conflicts_resolved      integer NOT NULL DEFAULT 0,
  status                  varchar(20) NOT NULL DEFAULT 'IN_PROGRESS',
  error_log               jsonb,
  client_last_sync_at     timestamptz,
  server_sync_cursor      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sync_sessions_clinic_device
  ON sync_sessions (clinic_id, device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  device_id               varchar(36),
  table_name              varchar(80) NOT NULL,
  record_id               uuid NOT NULL,
  local_data              jsonb,
  remote_data             jsonb,
  conflict_type           varchar(40) NOT NULL,
  resolution              varchar(40) DEFAULT 'MANUAL_PENDING',
  resolved_at             timestamptz,
  resolved_by             varchar(120),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_clinic
  ON sync_conflicts (clinic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_sync_cursors (
  clinic_id               uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  device_id               varchar(36) NOT NULL,
  cursor_ts               timestamptz NOT NULL DEFAULT to_timestamp(0),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, device_id)
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id             uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  movement_type           varchar(40) NOT NULL,
  reference_id            uuid,
  reference_type          varchar(40),
  qty_before                integer,
  qty_change                integer NOT NULL,
  qty_after                 integer,
  note                    text,
  device_id               varchar(36),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_clinic_med
  ON stock_ledger (clinic_id, medicine_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Sync columns on existing tables (additive)
-- ---------------------------------------------------------------------------

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS invoice_prefix varchar(20) DEFAULT 'CLI';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS invoice_counter integer DEFAULT 1;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS timezone varchar(64) DEFAULT 'Asia/Kolkata';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS sync_interval_minutes integer DEFAULT 10;

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sales ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 1;
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS last_writer_device_id varchar(36);
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS sync_checksum varchar(64);

-- Backfill updated_at from created_at where needed
UPDATE medicines SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE customers SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE suppliers SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE sales SET updated_at = sale_date WHERE updated_at IS NULL;
UPDATE sale_items si
SET updated_at = s.sale_date
FROM sales s
WHERE s.id = si.sale_id AND si.updated_at IS NULL;
UPDATE purchases SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE expenses SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE medicine_batches SET updated_at = created_at WHERE updated_at IS NULL;

-- Version / updated_at bumps are applied in application code for /api/v1/sync
-- to avoid double-counting with legacy routes.

COMMENT ON TABLE sync_sessions IS 'Offline-first sync session audit';
COMMENT ON TABLE device_sync_cursors IS 'Per-device pull watermark';
