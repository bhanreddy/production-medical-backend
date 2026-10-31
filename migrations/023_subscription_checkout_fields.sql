-- PhonePe checkout uses these fields in addition to the legacy Razorpay IDs.
ALTER TABLE clinic_subscriptions
  ADD COLUMN IF NOT EXISTS payment_merchant_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_provider_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_subscription_merchant_order
  ON clinic_subscriptions(payment_merchant_order_id) WHERE payment_merchant_order_id IS NOT NULL;
ALTER TABLE clinic_subscriptions DROP CONSTRAINT IF EXISTS clinic_subscriptions_status_check;
ALTER TABLE clinic_subscriptions ADD CONSTRAINT clinic_subscriptions_status_check
  CHECK (status IN ('created','authenticated','active','paused','cancelled','expired','trial','pending','halted'));
