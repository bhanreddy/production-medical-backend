-- Migration: Offline-First Architecture (Phase 1)
-- Description: Adds offline sync columns and triggers to all tables.

-- List of all tables:
-- clinics, users, suppliers, customers, medicines, medicine_batches,
-- purchases, purchase_items, sales, sale_items, expenses, shortbook,
-- refill_reminders, audit_logs, device_tokens, subscription_plans,
-- clinic_subscriptions, subscription_invoices

DO $$ 
DECLARE
  t text;
  tables text[] := ARRAY[
    'clinics', 'users', 'suppliers', 'customers', 'medicines', 'medicine_batches',
    'purchases', 'purchase_items', 'sales', 'sale_items', 'expenses', 'shortbook',
    'refill_reminders', 'audit_logs', 'device_tokens', 'subscription_plans',
    'clinic_subscriptions', 'subscription_invoices'
  ];
BEGIN
  -- Create the generic trigger function if it doesn't exist
  CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER AS $func$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
  $func$ LANGUAGE plpgsql;

  FOREACH t IN ARRAY tables LOOP
    -- Add columns
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS _local_id TEXT UNIQUE;', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;', t);

    -- Create unique index
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_local_id ON %I(_local_id);', t, t);

    -- Create trigger (requires dropping if exists first to avoid duplicates, or using conditional logic)
    -- Using a safe approach to drop and recreate the trigger
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;', t, t);
    EXECUTE format('
      CREATE TRIGGER trg_%I_updated_at
      BEFORE UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    ', t, t);
  END LOOP;
END $$;
