-- Supporting tables required by the legacy sync migrations and operational routes.
-- Keep startup valid for a fresh installation using the canonical schema.

CREATE TABLE IF NOT EXISTS refill_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  medicine_id  uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  remind_on    date NOT NULL,
  is_sent      boolean NOT NULL DEFAULT false,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,       -- CREATE | UPDATE | DELETE
  table_name  text NOT NULL,
  record_id   uuid,
  old_data    jsonb,
  new_data    jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios', 'android')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, expo_push_token)
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,      -- trial | basic | pro | custom
  display_name text NOT NULL,
  price_monthly  numeric NOT NULL DEFAULT 0,
  price_annual   numeric NOT NULL DEFAULT 0,
  razorpay_plan_id_monthly text,         -- from Razorpay dashboard
  razorpay_plan_id_annual  text,
  features    jsonb NOT NULL DEFAULT '{}',
  limits      jsonb NOT NULL DEFAULT '{}',  -- { max_users: 2, max_daily_bills: 25 }
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinic_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  plan_name               text NOT NULL,
  razorpay_subscription_id text UNIQUE,
  razorpay_customer_id    text,
  status                  text NOT NULL DEFAULT 'created'
                            CHECK (status IN ('created','authenticated','active','paused','cancelled','expired','trial')),
  billing_cycle           text NOT NULL DEFAULT 'monthly'
                            CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinics(id),
  subscription_id       uuid REFERENCES clinic_subscriptions(id),
  razorpay_invoice_id   text,
  razorpay_payment_id   text,
  amount                numeric NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
