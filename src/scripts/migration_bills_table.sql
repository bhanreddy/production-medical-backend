-- Migration for bills table
CREATE TABLE IF NOT EXISTS bills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  clinic_id UUID NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient querying by clinic
CREATE INDEX IF NOT EXISTS idx_bills_clinic_id ON bills(clinic_id);

-- Optional: If modifying existing sales table to act as bills
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_id TEXT UNIQUE;
