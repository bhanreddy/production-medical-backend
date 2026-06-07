-- Add offline-first sync columns to all syncable tables in Supabase
-- These columns enable the desktop and mobile apps to sync with the server

-- Helper function to add columns safely
DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY[
        'suppliers', 'customers', 'medicines', 'medicine_batches',
        'purchases', 'purchase_items', 'sales', 'sale_items',
        'expenses', 'shortbook', 'refill_reminders'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables
    LOOP
        -- _local_id: client-generated UUID for idempotent sync
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS _local_id TEXT UNIQUE', tbl);
        
        -- updated_at: timestamp for delta sync (pull changes since X)
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()', tbl);
        
        -- deleted_at: soft-delete timestamp (never hard-delete medical data)
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ', tbl);
        
        RAISE NOTICE 'Updated table: %', tbl;
    END LOOP;
END
$$;

-- Create trigger function to auto-set updated_at on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply the trigger to all syncable tables
DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY[
        'suppliers', 'customers', 'medicines', 'medicine_batches',
        'purchases', 'purchase_items', 'sales', 'sale_items',
        'expenses', 'shortbook', 'refill_reminders'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;
            CREATE TRIGGER trg_set_updated_at
                BEFORE UPDATE ON %I
                FOR EACH ROW
                EXECUTE FUNCTION set_updated_at();
        ', tbl, tbl);
        RAISE NOTICE 'Trigger created for: %', tbl;
    END LOOP;
END
$$;
