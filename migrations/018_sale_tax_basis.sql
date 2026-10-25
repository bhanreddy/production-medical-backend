-- Preserve the pricing basis so returns exactly reverse the original charge.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_includes_tax BOOLEAN NOT NULL DEFAULT false;
