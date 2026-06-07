import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.LOCAL_DB_PATH || path.join(__dirname, '..', 'local.db');
export const localDb = new Database(DB_PATH);

export function initLocalDb() {
  localDb.exec(`
    -- Sync queue table (ONE per local DB)
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
      payload TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
      created_at TEXT NOT NULL
    );

    -- Sync metadata
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('last_pulled_at', '1970-01-01T00:00:00.000Z');

    -- Mirror tables
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT, name TEXT, slug TEXT, address TEXT, phone TEXT, email TEXT,
      gstin TEXT, drug_licence_number TEXT, logo_url TEXT, signature_url TEXT,
      invoice_footer TEXT, plan TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT, clinic_id TEXT, full_name TEXT, phone TEXT, role TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT, clinic_id TEXT, name TEXT, phone TEXT, email TEXT, gstin TEXT, drug_licence_number TEXT, address TEXT,
      outstanding_balance REAL, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT, clinic_id TEXT, name TEXT, phone TEXT, email TEXT, doctor_name TEXT, address TEXT,
      outstanding_balance REAL, total_purchases REAL, importance_score INTEGER, last_purchase_date TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT, clinic_id TEXT, name TEXT, generic_name TEXT, manufacturer TEXT, category TEXT, hsn_code TEXT, gst_rate REAL,
      unit TEXT, is_schedule_h1 INTEGER, low_stock_threshold INTEGER, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicine_batches (
      id TEXT, clinic_id TEXT, medicine_id TEXT, supplier_id TEXT, purchase_id TEXT, batch_number TEXT, expiry_date TEXT,
      mrp REAL, purchase_price REAL, quantity_in INTEGER, quantity_remaining INTEGER, created_at TEXT,
      is_disposed INTEGER DEFAULT 0, disposed_at TEXT, disposed_by TEXT, disposal_reason TEXT, disposal_notes TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT, clinic_id TEXT, supplier_id TEXT, invoice_number TEXT, invoice_date TEXT, bill_image_url TEXT,
      subtotal REAL, discount REAL, gst_amount REAL, net_amount REAL, payment_status TEXT, paid_amount REAL, notes TEXT, created_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT, clinic_id TEXT, purchase_id TEXT, medicine_id TEXT, batch_id TEXT, batch_number TEXT, expiry_date TEXT,
      quantity INTEGER, purchase_price REAL, mrp REAL, gst_rate REAL, discount REAL, total REAL,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT, clinic_id TEXT, supplier_id TEXT, po_number TEXT, status TEXT, order_date TEXT, expected_date TEXT,
      notes TEXT, lines_json TEXT DEFAULT '[]', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT, clinic_id TEXT, customer_id TEXT, invoice_number TEXT, sale_date TEXT, subtotal REAL, discount REAL,
      gst_amount REAL, net_amount REAL, payment_mode TEXT, payment_status TEXT, paid_amount REAL, balance_due REAL, served_by TEXT,
      is_return INTEGER, return_of TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT, clinic_id TEXT, sale_id TEXT, medicine_id TEXT, batch_id TEXT, quantity INTEGER, mrp REAL, discount_pct REAL, gst_rate REAL, total REAL,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT, clinic_id TEXT, category TEXT, description TEXT, amount REAL, expense_date TEXT, payment_mode TEXT, recorded_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shortbook (
      id TEXT, clinic_id TEXT, medicine_id TEXT, reason TEXT, quantity_needed INTEGER, preferred_supplier_id TEXT, is_ordered INTEGER, ordered_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refill_reminders (
      id TEXT, clinic_id TEXT, customer_id TEXT, medicine_id TEXT, remind_on TEXT, is_sent INTEGER, sent_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT, clinic_id TEXT, user_id TEXT, action TEXT, table_name TEXT, record_id TEXT, old_data TEXT, new_data TEXT, ip_address TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT, clinic_id TEXT, user_id TEXT, expo_push_token TEXT, platform TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT, name TEXT, display_name TEXT, price_monthly REAL, price_annual REAL, razorpay_plan_id_monthly TEXT, razorpay_plan_id_annual TEXT, features TEXT, limits TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clinic_subscriptions (
      id TEXT, clinic_id TEXT, plan_name TEXT, razorpay_subscription_id TEXT, razorpay_customer_id TEXT, payment_merchant_order_id TEXT, payment_provider_order_id TEXT, status TEXT, billing_cycle TEXT, current_period_start TEXT, current_period_end TEXT, trial_end TEXT, cancelled_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id TEXT, clinic_id TEXT, subscription_id TEXT, razorpay_invoice_id TEXT, razorpay_payment_id TEXT, amount REAL, status TEXT, paid_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );
  `);
}

// Call init on load
initLocalDb();
