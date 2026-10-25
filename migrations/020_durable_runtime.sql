-- Private server state. Browser roles must never access checkpoints or original documents.
CREATE TABLE IF NOT EXISTS app_runtime_checkpoints (
  name text PRIMARY KEY,
  image bytea NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_prescription_documents (
  storage_key text PRIMARY KEY,
  content bytea NOT NULL CHECK (octet_length(content) <= 10485760),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_runtime_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_prescription_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_runtime_checkpoints, app_prescription_documents FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON app_runtime_checkpoints, app_prescription_documents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON app_runtime_checkpoints, app_prescription_documents FROM authenticated;
  END IF;
END $$;
