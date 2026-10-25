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

    -- Organizations & Multi-Store Hierarchy
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT, legal_name TEXT, display_name TEXT, code TEXT, gstin TEXT, pan TEXT,
      registered_address TEXT, billing_address TEXT, phone TEXT, email TEXT, status TEXT DEFAULT 'active',
      timezone TEXT DEFAULT 'Asia/Kolkata', currency TEXT DEFAULT 'INR', financial_year_start TEXT DEFAULT '04-01',
      default_state_code TEXT DEFAULT '36', created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regions (
      id TEXT, organization_id TEXT, code TEXT, name TEXT, parent_region_id TEXT, manager_user_id TEXT,
      status TEXT DEFAULT 'active', metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT, organization_id TEXT, region_id TEXT, clinic_id TEXT, store_code TEXT, name TEXT, display_name TEXT,
      address TEXT, locality TEXT, city TEXT, district TEXT, state TEXT, state_code TEXT, pincode TEXT,
      latitude REAL, longitude REAL, gstin_override TEXT, drug_licence_number TEXT, secondary_licence_number TEXT,
      phone TEXT, email TEXT, opening_time TEXT DEFAULT '09:00', closing_time TEXT DEFAULT '22:00', timezone TEXT DEFAULT 'Asia/Kolkata',
      status TEXT DEFAULT 'active', fulfilment_enabled INTEGER DEFAULT 1, delivery_enabled INTEGER DEFAULT 0,
      click_collect_enabled INTEGER DEFAULT 0, warehouse_served_by TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT, organization_id TEXT, region_id TEXT, warehouse_code TEXT, name TEXT, address TEXT,
      gstin TEXT, state_code TEXT, status TEXT DEFAULT 'active', cold_storage_supported INTEGER DEFAULT 0,
      manager_user_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS counters (
      id TEXT, organization_id TEXT, store_id TEXT, counter_code TEXT, name TEXT, status TEXT DEFAULT 'active',
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, device_uuid TEXT, terminal_code TEXT,
      terminal_name TEXT, platform TEXT, app_version TEXT, last_seen_at TEXT, last_sync_at TEXT,
      status TEXT DEFAULT 'active', printer_profile_id TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_organization_access (
      id TEXT, user_id TEXT, organization_id TEXT, role TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_store_access (
      id TEXT, user_id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, role TEXT,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS financial_years (
      id TEXT, organization_id TEXT, name TEXT, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'OPEN',
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_sequences (
      id TEXT, organization_id TEXT, store_id TEXT, document_type TEXT, financial_year_id TEXT,
      prefix TEXT, suffix TEXT DEFAULT '', padding INTEGER DEFAULT 4, current_sequence INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_positions (
      id TEXT, organization_id TEXT, medicine_id TEXT, batch_id TEXT, location_type TEXT,
      store_id TEXT, warehouse_id TEXT, quantity_on_hand INTEGER DEFAULT 0, quantity_reserved INTEGER DEFAULT 0,
      quantity_available INTEGER DEFAULT 0, quantity_in_transit INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_barcodes (
      id TEXT, organization_id TEXT, medicine_id TEXT, barcode TEXT, barcode_type TEXT,
      unit_type TEXT, conversion_factor REAL DEFAULT 1.0, is_primary INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT, organization_id TEXT, store_id TEXT, terminal_id TEXT, sale_id TEXT, return_id TEXT,
      tender_type TEXT DEFAULT 'CASH', amount REAL NOT NULL, amount_paise INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR', reference_number TEXT, status TEXT DEFAULT 'COMPLETED',
      provider TEXT, change_returned_paise INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT, organization_id TEXT, store_id TEXT, sale_id TEXT, sale_item_id TEXT,
      medicine_id TEXT, batch_id TEXT, allocated_quantity REAL NOT NULL, base_quantity REAL NOT NULL,
      unit_type TEXT DEFAULT 'STRIP', unit_price REAL NOT NULL, cost_price REAL DEFAULT 0,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parked_sales (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, terminal_id TEXT,
      cashier_id TEXT, customer_id TEXT, park_token TEXT NOT NULL,
      cart_snapshot TEXT NOT NULL DEFAULT '[]', customer_snapshot TEXT DEFAULT '{}', totals_snapshot TEXT DEFAULT '{}',
      notes TEXT, status TEXT DEFAULT 'PARKED', resumed_at TEXT, resumed_counter_id TEXT, resumed_terminal_id TEXT,
      resumed_by TEXT, expires_at TEXT NOT NULL, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supervisor_authorizations (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, terminal_id TEXT,
      action_type TEXT NOT NULL, requesting_user_id TEXT NOT NULL, authorizing_user_id TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, reason TEXT NOT NULL, old_value TEXT, new_value TEXT,
      status TEXT DEFAULT 'APPROVED', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Mirror tables
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT, organization_id TEXT, name TEXT, slug TEXT, address TEXT, phone TEXT, email TEXT,
      gstin TEXT, drug_licence_number TEXT, logo_url TEXT, signature_url TEXT,
      invoice_footer TEXT, plan TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT, clinic_id TEXT, full_name TEXT, phone TEXT, role TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT, organization_id TEXT, store_id TEXT, clinic_id TEXT, name TEXT, phone TEXT, email TEXT, gstin TEXT, drug_licence_number TEXT, address TEXT,
      outstanding_balance REAL DEFAULT 0, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT, organization_id TEXT, store_id TEXT, clinic_id TEXT, name TEXT, phone TEXT, email TEXT, doctor_name TEXT, address TEXT,
      outstanding_balance REAL DEFAULT 0, total_purchases REAL DEFAULT 0, importance_score INTEGER DEFAULT 0, last_purchase_date TEXT, is_active INTEGER, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT, organization_id TEXT, clinic_id TEXT, name TEXT, product_type TEXT DEFAULT 'MEDICINE', brand_name TEXT, generic_name TEXT, composition TEXT,
      dosage_form TEXT, strength TEXT, pack_size TEXT, base_unit TEXT DEFAULT 'strip', sale_unit TEXT DEFAULT 'strip', conversion_factor REAL DEFAULT 1.0,
      manufacturer TEXT, marketer TEXT, category TEXT, category_id TEXT, subcategory_id TEXT, hsn_code TEXT, gst_rate REAL DEFAULT 12,
      primary_barcode TEXT, is_schedule_h1 INTEGER DEFAULT 0, prescription_required INTEGER DEFAULT 0, schedule_classification TEXT DEFAULT 'NONE',
      cold_chain_required INTEGER DEFAULT 0, storage_instructions TEXT, minimum_margin_percent REAL DEFAULT 0, preferred_supplier_id TEXT,
      unit TEXT DEFAULT 'strip', low_stock_threshold INTEGER DEFAULT 10, is_active INTEGER DEFAULT 1, discontinued_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medicine_batches (
      id TEXT, organization_id TEXT, store_id TEXT, clinic_id TEXT, medicine_id TEXT, supplier_id TEXT, purchase_id TEXT, batch_number TEXT, expiry_date TEXT,
      mrp REAL, purchase_price REAL, quantity_in INTEGER, quantity_remaining INTEGER, created_at TEXT,
      is_disposed INTEGER DEFAULT 0, disposed_at TEXT, disposed_by TEXT, disposal_reason TEXT, disposal_notes TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, terminal_id TEXT, clinic_id TEXT, supplier_id TEXT, invoice_number TEXT, bill_number TEXT, invoice_date TEXT, bill_image_url TEXT,
      subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, gst_amount REAL DEFAULT 0, net_amount REAL DEFAULT 0, grand_total REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid', paid_amount REAL DEFAULT 0, notes TEXT, created_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT, organization_id TEXT, store_id TEXT, clinic_id TEXT, purchase_id TEXT, medicine_id TEXT, batch_id TEXT, batch_number TEXT, expiry_date TEXT,
      quantity INTEGER, purchase_price REAL, mrp REAL, gst_rate REAL, discount REAL, total REAL,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, terminal_id TEXT, clinic_id TEXT, customer_id TEXT, invoice_number TEXT, sale_date TEXT, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0, net_amount REAL DEFAULT 0, grand_total REAL DEFAULT 0, payment_mode TEXT, payment_status TEXT, paid_amount REAL DEFAULT 0, balance_due REAL DEFAULT 0, served_by TEXT,
      doctor_name TEXT, doctor_registration_number TEXT, prescription_number TEXT, prescription_url TEXT, prescription_image_url TEXT, prescription_required INTEGER DEFAULT 0,
      idempotency_key TEXT, is_parked INTEGER DEFAULT 0, park_id TEXT, exchange_of_sale_id TEXT, credit_note_number TEXT,
      is_return INTEGER DEFAULT 0, return_of TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT, organization_id TEXT, store_id TEXT, clinic_id TEXT, sale_id TEXT, sale_item_id TEXT, medicine_id TEXT, batch_id TEXT, quantity INTEGER,
      unit_type TEXT DEFAULT 'STRIP', conversion_factor REAL DEFAULT 1.0, base_quantity REAL DEFAULT 0,
      mrp_paise INTEGER DEFAULT 0, unit_price_paise INTEGER DEFAULT 0, discount_amount_paise INTEGER DEFAULT 0, taxable_amount_paise INTEGER DEFAULT 0, tax_amount_paise INTEGER DEFAULT 0,
      schedule_type TEXT DEFAULT 'NONE', is_prescription_required INTEGER DEFAULT 0,
      unit_price REAL, mrp REAL, discount_pct REAL DEFAULT 0, gst_rate REAL DEFAULT 12, total REAL, reason TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT, organization_id TEXT, store_id TEXT, counter_id TEXT, terminal_id TEXT, clinic_id TEXT, category TEXT, description TEXT, amount REAL, expense_date TEXT, payment_mode TEXT, recorded_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shortbook (
      id TEXT, clinic_id TEXT, medicine_id TEXT, reason TEXT, quantity_needed INTEGER, preferred_supplier_id TEXT, is_ordered INTEGER DEFAULT 0, ordered_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_ledger (
      id TEXT, organization_id TEXT, store_id TEXT, warehouse_id TEXT, source_location_type TEXT, source_location_id TEXT,
      destination_location_type TEXT, destination_location_id TEXT, counter_id TEXT, terminal_id TEXT,
      clinic_id TEXT, medicine_id TEXT, batch_id TEXT, movement_type TEXT, quantity_delta INTEGER, balance_after INTEGER, reference_id TEXT, notes TEXT, performed_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Commercial Engine: Price Books & Scopes
    CREATE TABLE IF NOT EXISTS price_books (
      id TEXT, organization_id TEXT, code TEXT, name TEXT, description TEXT, currency TEXT DEFAULT 'INR',
      priority INTEGER DEFAULT 10, status TEXT DEFAULT 'ACTIVE', scope TEXT DEFAULT 'ORGANIZATION',
      is_default INTEGER DEFAULT 0, start_at TEXT, end_at TEXT, created_by TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_book_scopes (
      id TEXT, organization_id TEXT, price_book_id TEXT, scope_type TEXT, scope_id TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_book_items (
      id TEXT, organization_id TEXT, price_book_id TEXT, medicine_id TEXT, batch_id TEXT,
      unit_type TEXT DEFAULT 'STRIP', mrp_paise INTEGER NOT NULL, selling_price_paise INTEGER NOT NULL,
      min_price_paise INTEGER DEFAULT 0, max_discount_pct REAL DEFAULT 100.0,
      start_at TEXT, end_at TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Customer Groups & Memberships
    CREATE TABLE IF NOT EXISTS customer_groups (
      id TEXT, organization_id TEXT, code TEXT, name TEXT, description TEXT,
      priority INTEGER DEFAULT 10, default_price_book_id TEXT, discount_pct REAL DEFAULT 0.0, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_group_members (
      id TEXT, organization_id TEXT, customer_group_id TEXT, customer_id TEXT,
      start_at TEXT, end_at TEXT, status TEXT DEFAULT 'ACTIVE', assigned_by TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_memberships (
      id TEXT, organization_id TEXT, customer_id TEXT, membership_number TEXT,
      membership_type TEXT DEFAULT 'STANDARD', tier TEXT DEFAULT 'SILVER', loyalty_multiplier REAL DEFAULT 1.0,
      start_at TEXT, end_at TEXT, status TEXT DEFAULT 'ACTIVE',
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Promotions & Applications
    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT, organization_id TEXT, code TEXT, name TEXT, description TEXT,
      promotion_type TEXT NOT NULL, priority INTEGER DEFAULT 10, stackability TEXT DEFAULT 'STACKABLE',
      start_at TEXT, end_at TEXT, status TEXT DEFAULT 'ACTIVE',
      usage_limit INTEGER, per_customer_limit INTEGER, current_uses INTEGER DEFAULT 0,
      channel_scope TEXT DEFAULT 'ALL', min_cart_value_paise INTEGER DEFAULT 0, max_discount_paise INTEGER,
      is_best_offer_eligible INTEGER DEFAULT 1, rule_version INTEGER DEFAULT 1, config_json TEXT DEFAULT '{}',
      created_by TEXT, approved_by TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_targets (
      id TEXT, organization_id TEXT, promotion_id TEXT, target_type TEXT, target_id TEXT, is_excluded INTEGER DEFAULT 0,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_rewards (
      id TEXT, organization_id TEXT, promotion_id TEXT, reward_type TEXT, reward_value REAL DEFAULT 0,
      reward_medicine_id TEXT, reward_quantity REAL DEFAULT 0, max_reward_value_paise INTEGER,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_applications (
      id TEXT, organization_id TEXT, store_id TEXT, sale_id TEXT, promotion_id TEXT,
      promotion_code TEXT, promotion_name TEXT, discount_amount_paise INTEGER DEFAULT 0,
      free_quantity REAL DEFAULT 0, reward_medicine_id TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Coupons & Redemptions
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT, organization_id TEXT, code TEXT, campaign_name TEXT, promotion_id TEXT,
      coupon_type TEXT DEFAULT 'PUBLIC', customer_id TEXT, discount_type TEXT DEFAULT 'FLAT', discount_value REAL DEFAULT 0,
      min_spend_paise INTEGER DEFAULT 0, max_discount_paise INTEGER, max_uses INTEGER,
      max_uses_per_customer INTEGER DEFAULT 1, current_uses INTEGER DEFAULT 0,
      start_at TEXT, end_at TEXT, status TEXT DEFAULT 'ACTIVE', is_active INTEGER DEFAULT 1, is_stackable INTEGER DEFAULT 1,
      eligible_stores TEXT DEFAULT '[]', eligible_products TEXT DEFAULT '[]',
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id TEXT, organization_id TEXT, coupon_id TEXT, customer_id TEXT, sale_id TEXT,
      discount_amount_paise INTEGER NOT NULL, redeemed_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Loyalty Programs, Accounts & Ledger Transactions
    CREATE TABLE IF NOT EXISTS loyalty_programs (
      id TEXT, organization_id TEXT, name TEXT, earn_rate_spend_paise INTEGER DEFAULT 10000,
      credits_per_earn_unit REAL DEFAULT 1.0, redemption_rate_paise_per_credit INTEGER DEFAULT 25,
      min_redemption_credits INTEGER DEFAULT 50, max_redemption_pct REAL DEFAULT 50.0,
      credit_expiry_days INTEGER DEFAULT 365, exclude_taxes_from_earn INTEGER DEFAULT 1,
      exclude_discounted_items INTEGER DEFAULT 0, status TEXT DEFAULT 'ACTIVE', is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      id TEXT, organization_id TEXT, customer_id TEXT, program_id TEXT,
      available_balance REAL DEFAULT 0, pending_balance REAL DEFAULT 0,
      lifetime_earned REAL DEFAULT 0, lifetime_redeemed REAL DEFAULT 0, status TEXT DEFAULT 'ACTIVE',
      updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT, organization_id TEXT, account_id TEXT, customer_id TEXT, sale_id TEXT, return_id TEXT,
      transaction_type TEXT NOT NULL, credits REAL NOT NULL, credits_balance_after REAL NOT NULL,
      monetary_value_paise INTEGER DEFAULT 0, notes TEXT, idempotency_key TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Supplier Schemes
    CREATE TABLE IF NOT EXISTS supplier_schemes (
      id TEXT, organization_id TEXT, supplier_id TEXT, name TEXT, scheme_type TEXT NOT NULL,
      medicine_id TEXT, category_id TEXT, manufacturer TEXT,
      min_quantity REAL DEFAULT 1, free_quantity REAL DEFAULT 0, discount_pct REAL DEFAULT 0.0,
      flat_discount_paise INTEGER DEFAULT 0, scheme_credit_paise INTEGER DEFAULT 0,
      start_at TEXT, end_at TEXT, status TEXT DEFAULT 'ACTIVE', priority INTEGER DEFAULT 10, config_json TEXT DEFAULT '{}',
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Sale Commercial Snapshots
    CREATE TABLE IF NOT EXISTS sale_commercial_snapshots (
      id TEXT, organization_id TEXT, store_id TEXT, sale_id TEXT,
      mrp_total_paise INTEGER NOT NULL, base_total_paise INTEGER NOT NULL,
      promo_discount_paise INTEGER DEFAULT 0, coupon_discount_paise INTEGER DEFAULT 0,
      member_discount_paise INTEGER DEFAULT 0, manual_discount_paise INTEGER DEFAULT 0,
      loyalty_redeemed_paise INTEGER DEFAULT 0, loyalty_earned_credits REAL DEFAULT 0,
      total_savings_paise INTEGER DEFAULT 0, gross_margin_paise INTEGER DEFAULT 0, gross_margin_pct REAL DEFAULT 0.0,
      applied_rules_json TEXT DEFAULT '{}', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Doctors Master
    CREATE TABLE IF NOT EXISTS doctors (
      id TEXT, organization_id TEXT, name TEXT NOT NULL, registration_number TEXT NOT NULL,
      registration_authority TEXT, specialization TEXT, phone TEXT, clinic_hospital TEXT, address TEXT,
      active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Prescriptions
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, patient_id TEXT, prescription_number TEXT NOT NULL,
      external_rx_number TEXT, doctor_id TEXT, doctor_name_snapshot TEXT NOT NULL, doctor_registration_number_snapshot TEXT NOT NULL,
      prescribed_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT, document_url TEXT NOT NULL, document_hash TEXT,
      source TEXT DEFAULT 'FILE_UPLOAD', status TEXT DEFAULT 'NEEDS_REVIEW', verification_status TEXT DEFAULT 'UNVERIFIED',
      verified_by TEXT, verified_at TEXT, assigned_to TEXT, assigned_at TEXT, rejection_reason TEXT, notes TEXT, created_by TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Prescription Items
    CREATE TABLE IF NOT EXISTS prescription_items (
      id TEXT, prescription_id TEXT NOT NULL, sequence INTEGER DEFAULT 1, raw_text TEXT NOT NULL, matched_product_id TEXT,
      generic_name TEXT, prescribed_name TEXT NOT NULL, strength TEXT, dosage_form TEXT, dose_text TEXT, frequency_text TEXT,
      duration_text TEXT, prescribed_quantity INTEGER DEFAULT 1, dispensed_quantity INTEGER DEFAULT 0, repeats_authorized INTEGER DEFAULT 0,
      repeats_used INTEGER DEFAULT 0, repeat_interval_days INTEGER, repeats_valid_until TEXT, substitution_allowed INTEGER DEFAULT 1,
      notes TEXT, match_status TEXT DEFAULT 'UNMATCHED', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Dispensing Events
    CREATE TABLE IF NOT EXISTS dispensing_events (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT NOT NULL, terminal_id TEXT, prescription_id TEXT NOT NULL,
      prescription_item_id TEXT NOT NULL, sale_id TEXT, sale_item_id TEXT, product_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      quantity_dispensed INTEGER NOT NULL, base_unit_quantity INTEGER DEFAULT 1, dispensed_by TEXT NOT NULL, dispensed_at TEXT NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Patient Allergies
    CREATE TABLE IF NOT EXISTS patient_allergies (
      id TEXT, organization_id TEXT NOT NULL, patient_id TEXT NOT NULL, allergen TEXT NOT NULL, allergen_type TEXT DEFAULT 'INGREDIENT',
      reaction_text TEXT, severity TEXT DEFAULT 'MODERATE', recorded_by TEXT, source TEXT DEFAULT 'MANUAL_ENTRY', active INTEGER DEFAULT 1, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Safety Warning Events
    CREATE TABLE IF NOT EXISTS safety_warning_events (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, prescription_id TEXT, sale_id TEXT, warning_type TEXT NOT NULL,
      severity TEXT NOT NULL, warning_text TEXT NOT NULL, acknowledged_by TEXT, acknowledged_at TEXT, action_taken TEXT, reason TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 4: Substitution Events
    CREATE TABLE IF NOT EXISTS substitution_events (
      id TEXT, organization_id TEXT NOT NULL, prescription_id TEXT NOT NULL, prescription_item_id TEXT NOT NULL, sale_id TEXT,
      prescribed_product_id TEXT, prescribed_name TEXT NOT NULL, dispensed_product_id TEXT NOT NULL, dispensed_name TEXT NOT NULL,
      substituted_by TEXT NOT NULL, reason TEXT NOT NULL, customer_confirmed INTEGER DEFAULT 0, doctor_confirmed INTEGER DEFAULT 0, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Stocktake Sessions
    CREATE TABLE IF NOT EXISTS stocktake_sessions (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, name TEXT NOT NULL,
      type TEXT DEFAULT 'FULL', scope TEXT DEFAULT '{}', counting_mode TEXT DEFAULT 'LIVE_COUNT',
      is_blind_count INTEGER DEFAULT 0, is_double_count INTEGER DEFAULT 0, status TEXT DEFAULT 'DRAFT',
      initiated_by TEXT NOT NULL, approved_by TEXT, reference_timestamp TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, approved_at TEXT, posted_at TEXT, notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Stocktake Items
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id TEXT, stocktake_id TEXT NOT NULL, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      batch_id TEXT, batch_number TEXT, expiry_date TEXT, expected_quantity REAL DEFAULT 0,
      physical_quantity REAL DEFAULT 0, difference REAL DEFAULT 0, unit_cost_paise INTEGER DEFAULT 0,
      value_difference_paise INTEGER DEFAULT 0, variance_reason TEXT, recount_status TEXT DEFAULT 'NONE',
      recount_count_a REAL, recount_count_b REAL, notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Stocktake Counts
    CREATE TABLE IF NOT EXISTS stocktake_counts (
      id TEXT, stocktake_id TEXT NOT NULL, stocktake_item_id TEXT, medicine_id TEXT NOT NULL,
      batch_id TEXT, counter_name TEXT, user_id TEXT NOT NULL, scanned_barcode TEXT,
      raw_quantity REAL DEFAULT 1, unit_type TEXT DEFAULT 'BASE', conversion_factor REAL DEFAULT 1.0,
      base_quantity REAL DEFAULT 1, device_id TEXT, is_offline_sync INTEGER DEFAULT 0, counted_at TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Product Recalls
    CREATE TABLE IF NOT EXISTS product_recalls (
      id TEXT, organization_id TEXT NOT NULL, recall_reference TEXT NOT NULL, recall_type TEXT DEFAULT 'BATCH',
      product_id TEXT NOT NULL, batch_id TEXT, batch_number TEXT, manufacturer TEXT, reason TEXT NOT NULL,
      severity TEXT DEFAULT 'CLASS_I', status TEXT DEFAULT 'DRAFT', initiated_at TEXT, completed_at TEXT,
      created_by TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Recall Tasks
    CREATE TABLE IF NOT EXISTS recall_tasks (
      id TEXT, recall_id TEXT NOT NULL, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT,
      location_type TEXT NOT NULL, expected_units REAL DEFAULT 0, quarantined_units REAL DEFAULT 0,
      discrepancy_units REAL DEFAULT 0, status TEXT DEFAULT 'PENDING', assigned_to TEXT, completed_by TEXT,
      completed_at TEXT, notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Inventory Reservations
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id TEXT, organization_id TEXT NOT NULL, location_type TEXT NOT NULL, store_id TEXT, warehouse_id TEXT,
      medicine_id TEXT NOT NULL, batch_id TEXT, quantity REAL NOT NULL, source_type TEXT NOT NULL,
      source_id TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT DEFAULT 'ACTIVE', created_by TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Inventory Alerts
    CREATE TABLE IF NOT EXISTS inventory_alerts (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, medicine_id TEXT,
      batch_id TEXT, alert_type TEXT NOT NULL, severity TEXT DEFAULT 'WARNING', title TEXT NOT NULL,
      message TEXT NOT NULL, status TEXT DEFAULT 'OPEN', acknowledged_by TEXT, acknowledged_at TEXT,
      metadata TEXT DEFAULT '{}', dedup_key TEXT UNIQUE, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Stockout Events
    CREATE TABLE IF NOT EXISTS stockout_events (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, medicine_id TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, duration_hours REAL, estimated_lost_demand REAL DEFAULT 0, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 5: Inventory Classifications
    CREATE TABLE IF NOT EXISTS inventory_classifications (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, medicine_id TEXT NOT NULL,
      abc_class TEXT DEFAULT 'C', movement_class TEXT DEFAULT 'NORMAL', avg_daily_sales_7d REAL DEFAULT 0,
      avg_daily_sales_30d REAL DEFAULT 0, avg_daily_sales_90d REAL DEFAULT 0, days_of_stock_cover REAL DEFAULT 0,
      last_sale_date TEXT, days_since_last_sale INTEGER DEFAULT 0, total_sales_units_90d REAL DEFAULT 0,
      total_sales_value_paise_90d INTEGER DEFAULT 0, computed_at TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Procurement Policies
    CREATE TABLE IF NOT EXISTS procurement_policies (
      id TEXT, organization_id TEXT NOT NULL, procurement_mode TEXT DEFAULT 'ENTERPRISE',
      store_manager_approval_limit_paise INTEGER DEFAULT 1000000, regional_manager_approval_limit_paise INTEGER DEFAULT 10000000,
      enforce_maker_checker INTEGER DEFAULT 0, price_variance_tolerance_pct REAL DEFAULT 0.50,
      quantity_variance_tolerance_pct REAL DEFAULT 2.00, tax_variance_exact INTEGER DEFAULT 1,
      min_shelf_life_days_receipt INTEGER DEFAULT 180, allow_excess_receipt_tolerance_pct REAL DEFAULT 2.00,
      auto_generate_debit_note INTEGER DEFAULT 1, payment_terms_default TEXT DEFAULT 'NET_30',
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Purchase Requisitions
    CREATE TABLE IF NOT EXISTS purchase_requisitions (
      id TEXT, organization_id TEXT NOT NULL, region_id TEXT, store_id TEXT, warehouse_id TEXT,
      requisition_number TEXT NOT NULL, source TEXT DEFAULT 'MANUAL', requested_by TEXT NOT NULL,
      requested_at TEXT, priority TEXT DEFAULT 'MEDIUM', required_by_date TEXT, status TEXT DEFAULT 'DRAFT',
      notes TEXT, approved_by TEXT, approved_at TEXT, rejection_reason TEXT, rejected_by TEXT, rejected_at TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Purchase Requisition Items
    CREATE TABLE IF NOT EXISTS purchase_requisition_items (
      id TEXT, requisition_id TEXT NOT NULL, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      requested_unit TEXT DEFAULT 'strip', conversion_factor REAL DEFAULT 1.0, base_quantity REAL DEFAULT 1,
      current_stock REAL DEFAULT 0, available_stock REAL DEFAULT 0, reserved_stock REAL DEFAULT 0,
      incoming_stock REAL DEFAULT 0, recommended_quantity REAL DEFAULT 0, requested_quantity REAL NOT NULL,
      ordered_quantity REAL DEFAULT 0, justification TEXT, preferred_supplier_id TEXT, urgency TEXT DEFAULT 'MEDIUM',
      estimated_cost_paise INTEGER DEFAULT 0, source_reference TEXT, status TEXT DEFAULT 'PENDING',
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Supplier Products Catalog
    CREATE TABLE IF NOT EXISTS supplier_products (
      id TEXT, organization_id TEXT NOT NULL, supplier_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      supplier_sku TEXT, purchase_unit TEXT DEFAULT 'strip', pack_size TEXT, conversion_factor REAL DEFAULT 1.0,
      moq REAL DEFAULT 1.0, standard_rate_paise INTEGER DEFAULT 0, last_purchase_rate_paise INTEGER DEFAULT 0,
      lead_time_days INTEGER DEFAULT 2, is_preferred INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, last_supplied_at TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Supplier Price History
    CREATE TABLE IF NOT EXISTS supplier_price_history (
      id TEXT, organization_id TEXT NOT NULL, supplier_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      rate_paise INTEGER NOT NULL, unit TEXT DEFAULT 'strip', scheme_summary TEXT, effective_cost_paise INTEGER NOT NULL,
      observed_at TEXT, source_type TEXT NOT NULL, reference_id TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Supplier Quotations
    CREATE TABLE IF NOT EXISTS supplier_quotations (
      id TEXT, organization_id TEXT NOT NULL, supplier_id TEXT NOT NULL, quotation_number TEXT NOT NULL,
      quotation_date TEXT NOT NULL, valid_until TEXT, status TEXT DEFAULT 'ACTIVE', notes TEXT,
      subtotal_paise INTEGER DEFAULT 0, gst_paise INTEGER DEFAULT 0, total_paise INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_quotation_items (
      id TEXT, quotation_id TEXT NOT NULL, medicine_id TEXT NOT NULL, quoted_quantity REAL DEFAULT 1,
      rate_paise INTEGER NOT NULL, gst_rate REAL DEFAULT 12.0, scheme_type TEXT, scheme_details TEXT,
      effective_cost_paise INTEGER NOT NULL, lead_time_days INTEGER DEFAULT 2, moq REAL DEFAULT 1, payment_terms TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Purchase order headers must exist before additive migrations on fresh installations.
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT, clinic_id TEXT, supplier_id TEXT, po_number TEXT, order_date TEXT,
      status TEXT DEFAULT 'DRAFT', notes TEXT, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0, total_amount REAL DEFAULT 0, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Purchase Order Items & Versions
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT, po_id TEXT NOT NULL, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      purchase_unit TEXT DEFAULT 'strip', conversion_factor REAL DEFAULT 1.0, ordered_quantity REAL NOT NULL,
      received_quantity REAL DEFAULT 0, free_quantity_expected REAL DEFAULT 0, purchase_rate_paise INTEGER NOT NULL,
      mrp_expected_paise INTEGER DEFAULT 0, discount_pct REAL DEFAULT 0.0, gst_rate REAL DEFAULT 12.0,
      supplier_scheme_id TEXT, scheme_summary TEXT, effective_cost_paise INTEGER NOT NULL,
      expected_expiry_threshold_days INTEGER DEFAULT 180, required_by_date TEXT, notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_versions (
      id TEXT, po_id TEXT NOT NULL, version_number INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      change_reason TEXT NOT NULL, changed_by TEXT NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_requisition_links (
      id TEXT, po_id TEXT NOT NULL, po_item_id TEXT NOT NULL, requisition_id TEXT NOT NULL,
      requisition_item_id TEXT NOT NULL, allocated_quantity REAL NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Goods Receipt Notes (GRN) & Items
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, supplier_id TEXT NOT NULL,
      po_id TEXT, grn_number TEXT NOT NULL, supplier_delivery_note TEXT, received_at TEXT, received_by TEXT NOT NULL,
      status TEXT DEFAULT 'DRAFT', notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id TEXT, grn_id TEXT NOT NULL, po_item_id TEXT, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      batch_number TEXT NOT NULL, manufacturing_date TEXT, expiry_date TEXT NOT NULL, ordered_quantity REAL DEFAULT 0,
      received_paid_quantity REAL DEFAULT 0, free_quantity REAL DEFAULT 0, rejected_quantity REAL DEFAULT 0,
      damaged_quantity REAL DEFAULT 0, short_quantity REAL DEFAULT 0, excess_quantity REAL DEFAULT 0,
      accepted_quantity REAL NOT NULL DEFAULT 0, purchase_rate_paise INTEGER NOT NULL, mrp_paise INTEGER DEFAULT 0,
      gst_rate REAL DEFAULT 12.0, discount_pct REAL DEFAULT 0.0, scheme_summary TEXT, effective_cost_paise INTEGER NOT NULL,
      rejection_reason TEXT, damage_notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Purchase Invoices, Items & 3-Way Match Results
    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, supplier_id TEXT NOT NULL,
      po_id TEXT, grn_id TEXT, invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
      payment_terms TEXT DEFAULT 'NET_30', subtotal_paise INTEGER DEFAULT 0, discount_paise INTEGER DEFAULT 0,
      gst_paise INTEGER DEFAULT 0, round_off_paise INTEGER DEFAULT 0, total_paise INTEGER DEFAULT 0,
      paid_amount_paise INTEGER DEFAULT 0, balance_due_paise INTEGER DEFAULT 0, payment_status TEXT DEFAULT 'UNPAID',
      match_status TEXT DEFAULT 'MATCHED', status TEXT DEFAULT 'DRAFT', notes TEXT, bill_image_url TEXT,
      ocr_extracted_json TEXT, posted_by TEXT, posted_at TEXT, created_by TEXT NOT NULL,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id TEXT, invoice_id TEXT NOT NULL, organization_id TEXT NOT NULL, po_item_id TEXT, grn_item_id TEXT,
      medicine_id TEXT NOT NULL, batch_number TEXT, quantity REAL NOT NULL, free_quantity REAL DEFAULT 0,
      purchase_rate_paise INTEGER NOT NULL, discount_pct REAL DEFAULT 0.0, gst_rate REAL DEFAULT 12.0,
      total_paise INTEGER NOT NULL, match_status TEXT DEFAULT 'MATCHED', variance_notes TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_match_results (
      id TEXT, invoice_id TEXT NOT NULL, po_id TEXT, grn_id TEXT, match_status TEXT NOT NULL,
      price_variance_paise INTEGER DEFAULT 0, price_variance_pct REAL DEFAULT 0.0, quantity_variance REAL DEFAULT 0,
      tax_variance_paise INTEGER DEFAULT 0, scheme_variance_summary TEXT, tolerance_applied INTEGER DEFAULT 0,
      is_exception INTEGER DEFAULT 0, exception_approved_by TEXT, exception_approved_at TEXT,
      exception_reason TEXT, match_details_json TEXT DEFAULT '{}', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Supplier Payable Ledger, Payments & Allocations
    CREATE TABLE IF NOT EXISTS supplier_payable_ledger (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, supplier_id TEXT NOT NULL,
      transaction_type TEXT NOT NULL, reference_id TEXT NOT NULL, reference_number TEXT, invoice_id TEXT,
      debit_paise INTEGER DEFAULT 0, credit_paise INTEGER DEFAULT 0, balance_after_paise INTEGER NOT NULL,
      notes TEXT, performed_by TEXT NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, supplier_id TEXT NOT NULL,
      payment_number TEXT NOT NULL, payment_date TEXT NOT NULL, payment_mode TEXT DEFAULT 'BANK_TRANSFER',
      reference_number TEXT, amount_paise INTEGER NOT NULL, unallocated_paise INTEGER DEFAULT 0,
      notes TEXT, recorded_by TEXT NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
      id TEXT, payment_id TEXT NOT NULL, invoice_id TEXT NOT NULL, allocated_amount_paise INTEGER NOT NULL,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 6: Debit Notes & Purchase Returns
    CREATE TABLE IF NOT EXISTS debit_notes (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, supplier_id TEXT NOT NULL,
      debit_note_number TEXT NOT NULL, return_id TEXT, invoice_id TEXT, amount_paise INTEGER NOT NULL,
      gst_paise INTEGER DEFAULT 0, status TEXT DEFAULT 'ISSUED', issued_at TEXT, created_by TEXT NOT NULL,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT, organization_id TEXT NOT NULL, store_id TEXT, warehouse_id TEXT, supplier_id TEXT NOT NULL,
      return_number TEXT NOT NULL, grn_id TEXT, invoice_id TEXT, reason TEXT NOT NULL, status TEXT DEFAULT 'POSTED',
      total_value REAL DEFAULT 0, total_value_paise INTEGER DEFAULT 0, gst_paise INTEGER DEFAULT 0, debit_note_id TEXT,
      created_by TEXT NOT NULL, approved_by TEXT, approved_at TEXT, posted_at TEXT, notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_return_lines (
      id TEXT, clinic_id TEXT, return_id TEXT NOT NULL, batch_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      quantity REAL NOT NULL, rate REAL NOT NULL,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 7: Multi-Store Transfers, Warehouse Operations & Central Replenishment
    CREATE TABLE IF NOT EXISTS transfer_policies (
      id TEXT, organization_id TEXT NOT NULL, auto_approve_routine_transfers INTEGER DEFAULT 0,
      auto_approve_value_limit_paise INTEGER DEFAULT 1000000, store_manager_approval_limit_paise INTEGER DEFAULT 5000000,
      regional_manager_approval_limit_paise INTEGER DEFAULT 20000000, enforce_maker_checker INTEGER DEFAULT 0,
      require_pack_verification INTEGER DEFAULT 1, require_fefo_allocation INTEGER DEFAULT 1,
      min_shelf_life_days_transfer INTEGER DEFAULT 60, allow_partial_receipt INTEGER DEFAULT 1,
      auto_close_on_exact_receipt INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS warehouse_bins (
      id TEXT, organization_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, parent_bin_id TEXT,
      bin_code TEXT NOT NULL, bin_name TEXT NOT NULL, zone TEXT, rack TEXT, shelf TEXT,
      bin_type TEXT DEFAULT 'STORAGE', pick_sequence INTEGER DEFAULT 100, is_active INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_bin_positions (
      id TEXT, organization_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, bin_id TEXT NOT NULL,
      medicine_id TEXT NOT NULL, batch_id TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT, organization_id TEXT NOT NULL, transfer_number TEXT NOT NULL, transfer_type TEXT NOT NULL,
      source_location_type TEXT NOT NULL, source_location_id TEXT NOT NULL,
      destination_location_type TEXT NOT NULL, destination_location_id TEXT NOT NULL,
      source_name TEXT, destination_name TEXT, priority TEXT DEFAULT 'NORMAL', reason TEXT DEFAULT 'MANUAL',
      status TEXT DEFAULT 'DRAFT', stock_state_transferred TEXT DEFAULT 'AVAILABLE',
      total_items INTEGER DEFAULT 0, total_quantity_requested REAL DEFAULT 0,
      total_quantity_dispatched REAL DEFAULT 0, total_quantity_received REAL DEFAULT 0,
      total_value_paise INTEGER DEFAULT 0, requested_by TEXT NOT NULL, requested_at TEXT,
      required_by_date TEXT, approved_by TEXT, approved_at TEXT, rejection_reason TEXT,
      rejected_by TEXT, rejected_at TEXT, pick_started_at TEXT, picked_by TEXT, picked_at TEXT,
      packed_by TEXT, packed_at TEXT, package_count INTEGER DEFAULT 0, is_cold_chain INTEGER DEFAULT 0,
      carrier_name TEXT, tracking_reference TEXT, dispatched_by TEXT, dispatched_at TEXT,
      estimated_arrival_at TEXT, received_by TEXT, received_at TEXT, completed_at TEXT,
      cancelled_by TEXT, cancelled_at TEXT, cancellation_reason TEXT, notes TEXT, idempotency_key TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id TEXT, transfer_id TEXT NOT NULL, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      medicine_name TEXT, requested_unit TEXT DEFAULT 'strip', conversion_factor REAL DEFAULT 1.0,
      requested_quantity REAL NOT NULL, base_quantity_requested REAL NOT NULL,
      allocated_quantity REAL DEFAULT 0, picked_quantity REAL DEFAULT 0, dispatched_quantity REAL DEFAULT 0,
      received_quantity REAL DEFAULT 0, damaged_quantity REAL DEFAULT 0, short_quantity REAL DEFAULT 0,
      excess_quantity REAL DEFAULT 0, rejected_quantity REAL DEFAULT 0, unit_cost_paise INTEGER DEFAULT 0,
      total_value_paise INTEGER DEFAULT 0, source_stock_snapshot REAL DEFAULT 0, destination_stock_snapshot REAL DEFAULT 0,
      notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_batch_allocations (
      id TEXT, transfer_id TEXT NOT NULL, transfer_item_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      medicine_id TEXT NOT NULL, batch_id TEXT NOT NULL, batch_number TEXT NOT NULL, expiry_date TEXT NOT NULL,
      unit_cost_paise INTEGER NOT NULL DEFAULT 0, mrp_paise INTEGER DEFAULT 0,
      quantity_allocated REAL NOT NULL DEFAULT 0, quantity_picked REAL DEFAULT 0, quantity_dispatched REAL DEFAULT 0,
      quantity_received REAL DEFAULT 0, quantity_damaged REAL DEFAULT 0, quantity_short REAL DEFAULT 0,
      quantity_excess REAL DEFAULT 0, reservation_id TEXT, source_bin_id TEXT, destination_bin_id TEXT,
      is_picked INTEGER DEFAULT 0, picked_at TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_packages (
      id TEXT, transfer_id TEXT NOT NULL, organization_id TEXT NOT NULL, package_identifier TEXT NOT NULL,
      package_number INTEGER NOT NULL DEFAULT 1, package_type TEXT DEFAULT 'BOX', is_cold_chain INTEGER DEFAULT 0,
      packed_by TEXT NOT NULL, packed_at TEXT, weight_kg REAL, special_instructions TEXT, seal_number TEXT,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_package_items (
      id TEXT, package_id TEXT NOT NULL, transfer_id TEXT NOT NULL, transfer_item_id TEXT NOT NULL,
      batch_allocation_id TEXT NOT NULL, medicine_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      quantity_packed REAL NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_receipts (
      id TEXT, transfer_id TEXT NOT NULL, organization_id TEXT NOT NULL, receipt_number TEXT NOT NULL,
      received_by TEXT NOT NULL, received_at TEXT, status TEXT DEFAULT 'COMPLETED', condition_status TEXT DEFAULT 'GOOD',
      notes TEXT, idempotency_key TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_receipt_items (
      id TEXT, receipt_id TEXT NOT NULL, transfer_id TEXT NOT NULL, transfer_item_id TEXT NOT NULL,
      batch_allocation_id TEXT NOT NULL, medicine_id TEXT NOT NULL, batch_id TEXT NOT NULL,
      quantity_dispatched REAL NOT NULL, quantity_accepted REAL NOT NULL, quantity_damaged REAL DEFAULT 0,
      quantity_short REAL DEFAULT 0, quantity_excess REAL DEFAULT 0, quantity_rejected REAL DEFAULT 0,
      destination_bin_id TEXT, damage_notes TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_variances (
      id TEXT, transfer_id TEXT NOT NULL, receipt_id TEXT, organization_id TEXT NOT NULL,
      medicine_id TEXT NOT NULL, batch_id TEXT NOT NULL, variance_type TEXT NOT NULL,
      expected_quantity REAL NOT NULL, actual_quantity REAL NOT NULL, variance_quantity REAL NOT NULL,
      unit_cost_paise INTEGER NOT NULL DEFAULT 0, variance_value_paise INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'REPORTED', resolution TEXT, resolution_notes TEXT,
      reported_by TEXT NOT NULL, reported_at TEXT, resolved_by TEXT, resolved_at TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_events (
      id TEXT, transfer_id TEXT NOT NULL, organization_id TEXT NOT NULL, event_type TEXT NOT NULL,
      from_status TEXT, to_status TEXT, performed_by TEXT NOT NULL, performer_name TEXT,
      details_json TEXT DEFAULT '{}', notes TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    -- Task 8: Omnichannel Order Management System (OMS)
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT, organization_id TEXT NOT NULL, customer_id TEXT NOT NULL, label TEXT,
      recipient_name TEXT NOT NULL, phone TEXT NOT NULL, address_line_1 TEXT NOT NULL, address_line_2 TEXT,
      locality TEXT, city TEXT NOT NULL, state TEXT NOT NULL, state_code TEXT, pincode TEXT NOT NULL,
      landmark TEXT, latitude REAL, longitude REAL, is_default INTEGER DEFAULT 0, delivery_instructions TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT, organization_id TEXT NOT NULL, order_number TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL,
      patient_id TEXT, source TEXT NOT NULL DEFAULT 'MANUAL', channel TEXT NOT NULL DEFAULT 'RETAIL',
      fulfilment_type TEXT NOT NULL DEFAULT 'STORE_PICKUP', requested_store_id TEXT, fulfilment_store_id TEXT,
      fulfilment_warehouse_id TEXT, status TEXT NOT NULL DEFAULT 'CREATED', prescription_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
      payment_status TEXT NOT NULL DEFAULT 'UNPAID', fulfilment_status TEXT NOT NULL DEFAULT 'UNASSIGNED',
      priority TEXT NOT NULL DEFAULT 'NORMAL', customer_notes TEXT, internal_notes TEXT,
      subtotal_paise INTEGER NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0,
      discount_total_paise INTEGER NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0,
      tax_total_paise INTEGER NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0,
      loyalty_redemption_paise INTEGER NOT NULL DEFAULT 0, loyalty_redemption_credits INTEGER NOT NULL DEFAULT 0,
      delivery_charge_paise INTEGER NOT NULL DEFAULT 0, delivery_charge REAL NOT NULL DEFAULT 0,
      round_off_paise INTEGER NOT NULL DEFAULT 0, round_off REAL NOT NULL DEFAULT 0,
      grand_total_paise INTEGER NOT NULL DEFAULT 0, grand_total REAL NOT NULL DEFAULT 0,
      commercial_snapshot_id TEXT, pickup_code TEXT, pickup_code_hash TEXT, pickup_verified_at TEXT,
      pickup_verified_by TEXT, sale_id TEXT, idempotency_key TEXT UNIQUE, quote_expires_at TEXT,
      requested_fulfilment_at TEXT, placed_at TEXT, confirmed_at TEXT, ready_at TEXT, completed_at TEXT,
      cancelled_at TEXT, cancellation_reason TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT, order_id TEXT NOT NULL, organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL,
      medicine_name TEXT NOT NULL, requested_unit TEXT NOT NULL DEFAULT 'STRIP', conversion_factor REAL NOT NULL DEFAULT 1.0,
      requested_quantity REAL NOT NULL DEFAULT 1.0, base_quantity REAL NOT NULL DEFAULT 1.0,
      fulfilled_quantity REAL NOT NULL DEFAULT 0.0, cancelled_quantity REAL NOT NULL DEFAULT 0.0,
      substituted_quantity REAL NOT NULL DEFAULT 0.0, prescription_required INTEGER DEFAULT 0,
      prescription_item_id TEXT, prescription_id TEXT, requested_product_snapshot TEXT DEFAULT '{}',
      mrp_paise INTEGER NOT NULL DEFAULT 0, unit_price_paise INTEGER NOT NULL DEFAULT 0,
      discount_amount_paise INTEGER NOT NULL DEFAULT 0, taxable_amount_paise INTEGER NOT NULL DEFAULT 0,
      tax_amount_paise INTEGER NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 12.0,
      line_total_paise INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'REQUESTED',
      substitution_policy TEXT NOT NULL DEFAULT 'NO_SUBSTITUTION', notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_address_snapshots (
      id TEXT, order_id TEXT NOT NULL, organization_id TEXT NOT NULL, address_id TEXT,
      recipient_name TEXT NOT NULL, phone TEXT NOT NULL, address_line_1 TEXT NOT NULL, address_line_2 TEXT,
      locality TEXT, city TEXT NOT NULL, state TEXT NOT NULL, state_code TEXT, pincode TEXT NOT NULL,
      landmark TEXT, latitude REAL, longitude REAL, delivery_instructions TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_commercial_snapshots (
      id TEXT, order_id TEXT NOT NULL, organization_id TEXT NOT NULL, pricing_version TEXT DEFAULT 'V1',
      quote_json TEXT NOT NULL, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_fulfilments (
      id TEXT, order_id TEXT NOT NULL, organization_id TEXT NOT NULL, fulfilment_group_number INTEGER NOT NULL DEFAULT 1,
      fulfilment_type TEXT NOT NULL DEFAULT 'STORE_PICKUP', location_type TEXT NOT NULL DEFAULT 'STORE',
      store_id TEXT, warehouse_id TEXT, status TEXT NOT NULL DEFAULT 'UNASSIGNED', priority TEXT NOT NULL DEFAULT 'NORMAL',
      assigned_at TEXT, pick_started_at TEXT, picked_at TEXT, packed_at TEXT, ready_at TEXT,
      dispatched_at TEXT, completed_at TEXT, cancelled_at TEXT, cancellation_reason TEXT, notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_fulfilment_items (
      id TEXT, fulfilment_id TEXT NOT NULL, order_id TEXT NOT NULL, order_item_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, medicine_id TEXT NOT NULL, batch_id TEXT,
      quantity_allocated REAL NOT NULL DEFAULT 0.0, quantity_picked REAL NOT NULL DEFAULT 0.0,
      quantity_packed REAL NOT NULL DEFAULT 0.0, reservation_id TEXT, status TEXT NOT NULL DEFAULT 'RESERVED',
      notes TEXT, created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_packages (
      id TEXT, order_id TEXT NOT NULL, fulfilment_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      package_number INTEGER NOT NULL DEFAULT 1, package_label TEXT NOT NULL, package_type TEXT DEFAULT 'BOX',
      is_cold_chain INTEGER DEFAULT 0, is_prescription_required INTEGER DEFAULT 0,
      packed_by TEXT NOT NULL, packed_at TEXT, special_instructions TEXT, seal_number TEXT, weight_kg REAL,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_package_items (
      id TEXT, package_id TEXT NOT NULL, order_id TEXT NOT NULL, fulfilment_id TEXT NOT NULL,
      order_item_id TEXT NOT NULL, medicine_id TEXT NOT NULL, batch_id TEXT, quantity REAL NOT NULL DEFAULT 1.0,
      created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_substitutions (
      id TEXT, order_id TEXT NOT NULL, order_item_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      original_medicine_id TEXT NOT NULL, original_medicine_name TEXT NOT NULL,
      suggested_medicine_id TEXT NOT NULL, suggested_medicine_name TEXT NOT NULL,
      original_unit_price_paise INTEGER NOT NULL DEFAULT 0, suggested_unit_price_paise INTEGER NOT NULL DEFAULT 0,
      price_difference_paise INTEGER NOT NULL DEFAULT 0, quantity REAL NOT NULL DEFAULT 1.0,
      reason TEXT NOT NULL, requested_by TEXT NOT NULL, customer_confirmed INTEGER DEFAULT 0,
      customer_confirmed_at TEXT, pharmacist_verified INTEGER DEFAULT 0, pharmacist_verified_by TEXT,
      pharmacist_verified_at TEXT, status TEXT NOT NULL DEFAULT 'PENDING', notes TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_refunds (
      id TEXT, order_id TEXT NOT NULL, organization_id TEXT NOT NULL, payment_transaction_id TEXT,
      amount_paise INTEGER NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', refund_reference TEXT, processed_by TEXT, processed_at TEXT,
      created_at TEXT, updated_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT, order_id TEXT NOT NULL, fulfilment_id TEXT, organization_id TEXT NOT NULL,
      event_type TEXT NOT NULL, from_status TEXT, to_status TEXT, actor_id TEXT, actor_name TEXT,
      details_json TEXT DEFAULT '{}', notes TEXT, created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_transfer_links (
      id TEXT, order_id TEXT NOT NULL, order_item_id TEXT, transfer_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'LINKED', created_at TEXT,
      _local_id TEXT PRIMARY KEY, _synced INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0, _updated_at TEXT NOT NULL
    );
  `);

  // Safe additive migrations for existing tables in local SQLite
  const safeAddColumns = [
    { table: 'inventory_positions', col: 'quantity_quarantined', type: 'REAL DEFAULT 0' },
    { table: 'inventory_positions', col: 'quantity_damaged', type: 'REAL DEFAULT 0' },
    { table: 'inventory_positions', col: 'quantity_recalled', type: 'REAL DEFAULT 0' },
    { table: 'inventory_positions', col: 'quantity_on_hold', type: 'REAL DEFAULT 0' },
    { table: 'inventory_positions', col: 'quantity_stocktake_locked', type: 'REAL DEFAULT 0' },
    { table: 'clinics', col: 'organization_id', type: 'TEXT' },
    { table: 'medicine_batches', col: 'is_disposed', type: 'INTEGER DEFAULT 0' },
    { table: 'medicine_batches', col: 'disposed_at', type: 'TEXT' },
    { table: 'medicine_batches', col: 'disposed_by', type: 'TEXT' },
    { table: 'medicine_batches', col: 'disposal_reason', type: 'TEXT' },
    { table: 'medicine_batches', col: 'disposal_notes', type: 'TEXT' },
    { table: 'medicine_batches', col: 'organization_id', type: 'TEXT' },
    { table: 'medicine_batches', col: 'store_id', type: 'TEXT' },
    { table: 'medicine_batches', col: 'cost_price_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'medicine_batches', col: 'mrp_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sales', col: 'grand_total', type: 'REAL DEFAULT 0' },
    { table: 'sales', col: 'paid_amount', type: 'REAL DEFAULT 0' },
    { table: 'sales', col: 'balance_due', type: 'REAL DEFAULT 0' },
    { table: 'sales', col: 'organization_id', type: 'TEXT' },
    { table: 'sales', col: 'store_id', type: 'TEXT' },
    { table: 'sales', col: 'counter_id', type: 'TEXT' },
    { table: 'sales', col: 'terminal_id', type: 'TEXT' },
    { table: 'sales', col: 'doctor_name', type: 'TEXT' },
    { table: 'sales', col: 'doctor_registration_number', type: 'TEXT' },
    { table: 'sales', col: 'prescription_number', type: 'TEXT' },
    { table: 'sales', col: 'prescription_image_url', type: 'TEXT' },
    { table: 'sales', col: 'prescription_required', type: 'INTEGER DEFAULT 0' },
    { table: 'sales', col: 'idempotency_key', type: 'TEXT' },
    { table: 'sales', col: 'is_parked', type: 'INTEGER DEFAULT 0' },
    { table: 'sales', col: 'park_id', type: 'TEXT' },
    { table: 'sales', col: 'status', type: 'TEXT DEFAULT "COMPLETED"' },
    { table: 'sales', col: 'exchange_of_sale_id', type: 'TEXT' },
    { table: 'sales', col: 'credit_note_number', type: 'TEXT' },
    { table: 'sale_items', col: 'sale_item_id', type: 'TEXT' },
    { table: 'sale_items', col: 'reason', type: 'TEXT' },
    { table: 'sale_items', col: 'unit_price', type: 'REAL' },
    { table: 'sale_items', col: 'organization_id', type: 'TEXT' },
    { table: 'sale_items', col: 'store_id', type: 'TEXT' },
    { table: 'sale_items', col: 'unit_type', type: 'TEXT DEFAULT "STRIP"' },
    { table: 'sale_items', col: 'conversion_factor', type: 'REAL DEFAULT 1.0' },
    { table: 'sale_items', col: 'base_quantity', type: 'REAL DEFAULT 0' },
    { table: 'sale_items', col: 'mrp_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'unit_price_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'discount_amount_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'taxable_amount_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'tax_amount_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'schedule_type', type: 'TEXT DEFAULT "NONE"' },
    { table: 'sale_items', col: 'is_prescription_required', type: 'INTEGER DEFAULT 0' },
    { table: 'sale_items', col: 'created_at', type: 'TEXT' },
    { table: 'sale_items', col: 'updated_at', type: 'TEXT' },
    { table: 'purchases', col: 'grand_total', type: 'REAL DEFAULT 0' },
    { table: 'purchases', col: 'bill_number', type: 'TEXT' },
    { table: 'purchases', col: 'organization_id', type: 'TEXT' },
    { table: 'purchases', col: 'store_id', type: 'TEXT' },
    { table: 'purchases', col: 'counter_id', type: 'TEXT' },
    { table: 'purchases', col: 'terminal_id', type: 'TEXT' },
    { table: 'purchase_items', col: 'organization_id', type: 'TEXT' },
    { table: 'purchase_items', col: 'store_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'organization_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'store_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'warehouse_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'region_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'financial_year_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'currency', type: 'TEXT DEFAULT "INR"' },
    { table: 'purchase_orders', col: 'expected_delivery_date', type: 'TEXT' },
    { table: 'purchase_orders', col: 'payment_terms', type: 'TEXT' },
    { table: 'purchase_orders', col: 'delivery_location_type', type: 'TEXT DEFAULT "STORE"' },
    { table: 'purchase_orders', col: 'delivery_location_id', type: 'TEXT' },
    { table: 'purchase_orders', col: 'subtotal_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_orders', col: 'discount_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_orders', col: 'gst_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_orders', col: 'total_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_orders', col: 'version', type: 'INTEGER DEFAULT 1' },
    { table: 'purchase_orders', col: 'created_by', type: 'TEXT' },
    { table: 'purchase_orders', col: 'approved_by', type: 'TEXT' },
    { table: 'purchase_orders', col: 'approved_at', type: 'TEXT' },
    { table: 'purchase_orders', col: 'sent_at', type: 'TEXT' },
    { table: 'purchase_orders', col: 'confirmed_at', type: 'TEXT' },
    { table: 'purchase_orders', col: 'cancelled_at', type: 'TEXT' },
    { table: 'purchase_orders', col: 'rejection_reason', type: 'TEXT' },
    { table: 'purchase_orders', col: 'terms_and_conditions', type: 'TEXT' },
    { table: 'purchase_orders', col: 'idempotency_key', type: 'TEXT' },
    { table: 'purchase_returns', col: 'organization_id', type: 'TEXT' },
    { table: 'purchase_returns', col: 'store_id', type: 'TEXT' },
    { table: 'purchase_returns', col: 'warehouse_id', type: 'TEXT' },
    { table: 'purchase_returns', col: 'return_number', type: 'TEXT' },
    { table: 'purchase_returns', col: 'grn_id', type: 'TEXT' },
    { table: 'purchase_returns', col: 'invoice_id', type: 'TEXT' },
    { table: 'purchase_returns', col: 'reason', type: 'TEXT' },
    { table: 'purchase_returns', col: 'total_value_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_returns', col: 'gst_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'purchase_returns', col: 'created_by', type: 'TEXT' },
    { table: 'purchase_returns', col: 'approved_by', type: 'TEXT' },
    { table: 'purchase_returns', col: 'approved_at', type: 'TEXT' },
    { table: 'purchase_returns', col: 'posted_at', type: 'TEXT' },
    { table: 'purchase_returns', col: 'debit_note_id', type: 'TEXT' },
    { table: 'expenses', col: 'organization_id', type: 'TEXT' },
    { table: 'expenses', col: 'store_id', type: 'TEXT' },
    { table: 'expenses', col: 'counter_id', type: 'TEXT' },
    { table: 'expenses', col: 'terminal_id', type: 'TEXT' },
    { table: 'customers', col: 'organization_id', type: 'TEXT' },
    { table: 'customers', col: 'store_id', type: 'TEXT' },
    { table: 'suppliers', col: 'organization_id', type: 'TEXT' },
    { table: 'suppliers', col: 'store_id', type: 'TEXT' },
    { table: 'suppliers', col: 'lead_time_days', type: 'INTEGER DEFAULT 2' },
    { table: 'suppliers', col: 'payment_terms', type: 'TEXT DEFAULT "NET_30"' },
    { table: 'medicines', col: 'organization_id', type: 'TEXT' },
    { table: 'medicines', col: 'product_type', type: 'TEXT DEFAULT "MEDICINE"' },
    { table: 'medicines', col: 'brand_name', type: 'TEXT' },
    { table: 'medicines', col: 'composition', type: 'TEXT' },
    { table: 'medicines', col: 'dosage_form', type: 'TEXT' },
    { table: 'medicines', col: 'strength', type: 'TEXT' },
    { table: 'medicines', col: 'pack_size', type: 'TEXT' },
    { table: 'medicines', col: 'base_unit', type: 'TEXT DEFAULT "strip"' },
    { table: 'medicines', col: 'sale_unit', type: 'TEXT DEFAULT "strip"' },
    { table: 'medicines', col: 'conversion_factor', type: 'REAL DEFAULT 1.0' },
    { table: 'medicines', col: 'marketer', type: 'TEXT' },
    { table: 'medicines', col: 'category_id', type: 'TEXT' },
    { table: 'medicines', col: 'subcategory_id', type: 'TEXT' },
    { table: 'medicines', col: 'primary_barcode', type: 'TEXT' },
    { table: 'medicines', col: 'prescription_required', type: 'INTEGER DEFAULT 0' },
    { table: 'medicines', col: 'schedule_classification', type: 'TEXT DEFAULT "NONE"' },
    { table: 'medicines', col: 'cold_chain_required', type: 'INTEGER DEFAULT 0' },
    { table: 'medicines', col: 'storage_instructions', type: 'TEXT' },
    { table: 'medicines', col: 'purchase_price', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'mrp', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'shelf_life_days', type: 'INTEGER DEFAULT 730' },
    { table: 'medicines', col: 'minimum_margin_percent', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'preferred_supplier_id', type: 'TEXT' },
    { table: 'medicines', col: 'discontinued_at', type: 'TEXT' },
    { table: 'medicines', col: 'minimum_order_quantity', type: 'INTEGER DEFAULT 1' },
    { table: 'medicines', col: 'reorder_level', type: 'INTEGER DEFAULT 10' },
    { table: 'medicines', col: 'reorder_quantity', type: 'INTEGER DEFAULT 20' },
    { table: 'medicines', col: 'units_per_pack', type: 'INTEGER DEFAULT 10' },
    { table: 'stock_ledger', col: 'organization_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'store_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'warehouse_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'location_type', type: 'TEXT' },
    { table: 'stock_ledger', col: 'source_location_type', type: 'TEXT' },
    { table: 'stock_ledger', col: 'source_location_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'destination_location_type', type: 'TEXT' },
    { table: 'stock_ledger', col: 'destination_location_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'counter_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'terminal_id', type: 'TEXT' },
    { table: 'stock_ledger', col: 'unit_cost_paise', type: 'INTEGER DEFAULT 0' },
    { table: 'stock_ledger', col: 'cost_per_unit', type: 'REAL DEFAULT 0' },
    { table: 'stock_ledger', col: 'reference_type', type: 'TEXT' },
    { table: 'stock_ledger', col: 'created_by', type: 'TEXT' },
    { table: 'medicines', col: 'min_stock', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'max_stock', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'mrp', type: 'REAL DEFAULT 0' },
    { table: 'medicines', col: 'storage_type', type: 'TEXT' },
    { table: 'payment_transactions', col: 'order_id', type: 'TEXT' },
    { table: 'sales', col: 'order_id', type: 'TEXT' },
    { table: 'stores', col: 'fulfilment_enabled', type: 'INTEGER DEFAULT 1' },
    { table: 'stores', col: 'delivery_enabled', type: 'INTEGER DEFAULT 0' },
    { table: 'stores', col: 'home_delivery_enabled', type: 'INTEGER DEFAULT 0' },
    { table: 'stores', col: 'click_collect_enabled', type: 'INTEGER DEFAULT 0' },
    { table: 'stores', col: 'opening_time', type: 'TEXT DEFAULT "09:00"' },
    { table: 'stores', col: 'closing_time', type: 'TEXT DEFAULT "22:00"' },
    { table: 'stores', col: 'cold_chain_supported', type: 'INTEGER DEFAULT 1' },
    { table: 'stores', col: 'cold_storage_supported', type: 'INTEGER DEFAULT 1' },
    { table: 'stores', col: 'max_active_orders', type: 'INTEGER DEFAULT 50' },
    { table: 'medicine_batches', col: 'is_recalled', type: 'INTEGER DEFAULT 0' },
  ];

  safeAddColumns.push({ table: 'users', col: 'email', type: 'TEXT' });

  for (const { table, col, type } of safeAddColumns) {
    try {
      localDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
    } catch {
      // Column already exists
    }
  }

  // Create after additive migrations so existing installations receive the indexes too.
  localDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_pos_batch_stock
      ON medicine_batches(medicine_id, store_id, expiry_date)
      WHERE _deleted = 0 AND quantity_remaining > 0 AND (is_disposed = 0 OR is_disposed IS NULL);
    CREATE INDEX IF NOT EXISTS idx_pos_barcode
      ON product_barcodes(barcode, organization_id) WHERE _deleted = 0;
    CREATE INDEX IF NOT EXISTS idx_pos_primary_barcode
      ON medicines(primary_barcode, organization_id) WHERE _deleted = 0 AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_pos_medicine_id ON medicines(id) WHERE _deleted = 0;
    CREATE INDEX IF NOT EXISTS idx_pos_generic
      ON medicines(LOWER(generic_name), organization_id) WHERE _deleted = 0 AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_pos_catalog
      ON medicines(organization_id) WHERE _deleted = 0 AND is_active = 1;
  `);

}

// Call init on load
initLocalDb();

