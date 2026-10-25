-- 011_enterprise_procurement_grn_payable.sql
-- Task 6: Enterprise Procurement, GRN, Purchase Control & Supplier Intelligence

-- 1. Procurement Policies
CREATE TABLE IF NOT EXISTS procurement_policies (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    procurement_mode VARCHAR(50) NOT NULL DEFAULT 'ENTERPRISE', -- SIMPLE, CONTROLLED, ENTERPRISE
    store_manager_approval_limit_paise BIGINT DEFAULT 1000000, -- e.g. ₹10,000
    regional_manager_approval_limit_paise BIGINT DEFAULT 10000000, -- e.g. ₹1,00,000
    enforce_maker_checker BOOLEAN DEFAULT FALSE,
    price_variance_tolerance_pct NUMERIC(5, 2) DEFAULT 0.50,
    quantity_variance_tolerance_pct NUMERIC(5, 2) DEFAULT 2.00,
    tax_variance_exact BOOLEAN DEFAULT TRUE,
    min_shelf_life_days_receipt INTEGER DEFAULT 180,
    allow_excess_receipt_tolerance_pct NUMERIC(5, 2) DEFAULT 2.00,
    auto_generate_debit_note BOOLEAN DEFAULT TRUE,
    payment_terms_default VARCHAR(50) DEFAULT 'NET_30',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proc_policy_org ON procurement_policies(organization_id);

-- 2. Purchase Requisitions
CREATE TABLE IF NOT EXISTS purchase_requisitions (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    region_id UUID REFERENCES regions(id) ON DELETE SET NULL,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    requisition_number VARCHAR(100) NOT NULL,
    source VARCHAR(50) NOT NULL DEFAULT 'MANUAL', -- MANUAL, REORDER_ENGINE, SHORTBOOK, STOCKOUT, PRESCRIPTION_DEMAND, EXPIRY_REBALANCE, WAREHOUSE_REPLENISHMENT, STORE_REQUEST
    requested_by VARCHAR(100) NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    priority VARCHAR(50) NOT NULL DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, URGENT
    required_by_date VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, SUBMITTED, PENDING_APPROVAL, APPROVED, PARTIALLY_ORDERED, ORDERED, REJECTED, CANCELLED, CLOSED
    notes TEXT,
    approved_by VARCHAR(100),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    rejected_by VARCHAR(100),
    rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requisitions_org_status ON purchase_requisitions(organization_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_requisitions_store ON purchase_requisitions(store_id);

-- 3. Purchase Requisition Items
CREATE TABLE IF NOT EXISTS purchase_requisition_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    requisition_id UUID NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    requested_unit VARCHAR(50) DEFAULT 'strip',
    conversion_factor NUMERIC(15, 4) DEFAULT 1.0,
    base_quantity NUMERIC(15, 4) NOT NULL DEFAULT 1,
    current_stock NUMERIC(15, 4) DEFAULT 0,
    available_stock NUMERIC(15, 4) DEFAULT 0,
    reserved_stock NUMERIC(15, 4) DEFAULT 0,
    incoming_stock NUMERIC(15, 4) DEFAULT 0,
    recommended_quantity NUMERIC(15, 4) DEFAULT 0,
    requested_quantity NUMERIC(15, 4) NOT NULL,
    ordered_quantity NUMERIC(15, 4) DEFAULT 0,
    justification TEXT,
    preferred_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    urgency VARCHAR(50) DEFAULT 'MEDIUM',
    estimated_cost_paise BIGINT DEFAULT 0,
    source_reference VARCHAR(255),
    status VARCHAR(50) DEFAULT 'PENDING', -- PENDING, ORDERED, CANCELLED
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_req_items_req ON purchase_requisition_items(requisition_id);
CREATE INDEX IF NOT EXISTS idx_req_items_med ON purchase_requisition_items(medicine_id);

-- 4. Supplier-Product Catalog
CREATE TABLE IF NOT EXISTS supplier_products (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    supplier_sku VARCHAR(100),
    purchase_unit VARCHAR(50) DEFAULT 'strip',
    pack_size VARCHAR(50),
    conversion_factor NUMERIC(15, 4) DEFAULT 1.0,
    moq NUMERIC(15, 4) DEFAULT 1.0,
    standard_rate_paise BIGINT NOT NULL DEFAULT 0,
    last_purchase_rate_paise BIGINT DEFAULT 0,
    lead_time_days INTEGER DEFAULT 2,
    is_preferred BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    last_supplied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, supplier_id, medicine_id)
);

CREATE INDEX IF NOT EXISTS idx_supp_prod_org_supp ON supplier_products(organization_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_supp_prod_med ON supplier_products(medicine_id);

-- 5. Supplier Price History
CREATE TABLE IF NOT EXISTS supplier_price_history (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    rate_paise BIGINT NOT NULL,
    unit VARCHAR(50) DEFAULT 'strip',
    scheme_summary TEXT,
    effective_cost_paise BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_type VARCHAR(50) NOT NULL, -- PURCHASE_INVOICE, QUOTATION, CONTRACT, GRN
    reference_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_supp_price_hist ON supplier_price_history(organization_id, supplier_id, medicine_id, observed_at);

-- 6. Supplier Quotations
CREATE TABLE IF NOT EXISTS supplier_quotations (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    quotation_number VARCHAR(100) NOT NULL,
    quotation_date VARCHAR(50) NOT NULL,
    valid_until VARCHAR(50),
    status VARCHAR(50) DEFAULT 'ACTIVE', -- ACTIVE, EXPIRED, ACCEPTED, REJECTED
    notes TEXT,
    subtotal_paise BIGINT DEFAULT 0,
    gst_paise BIGINT DEFAULT 0,
    total_paise BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_quotation_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    quotation_id UUID NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    quoted_quantity NUMERIC(15, 4) DEFAULT 1,
    rate_paise BIGINT NOT NULL,
    gst_rate NUMERIC(5, 2) DEFAULT 12.0,
    scheme_type VARCHAR(50),
    scheme_details TEXT,
    effective_cost_paise BIGINT NOT NULL,
    lead_time_days INTEGER DEFAULT 2,
    moq NUMERIC(15, 4) DEFAULT 1,
    payment_terms VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Purchase Orders (Enhanced Enterprise Schema)
-- (Modifies / enhances existing purchase_orders table)
CREATE TABLE IF NOT EXISTS purchase_order_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    purchase_unit VARCHAR(50) DEFAULT 'strip',
    conversion_factor NUMERIC(15, 4) DEFAULT 1.0,
    ordered_quantity NUMERIC(15, 4) NOT NULL,
    received_quantity NUMERIC(15, 4) DEFAULT 0,
    free_quantity_expected NUMERIC(15, 4) DEFAULT 0,
    purchase_rate_paise BIGINT NOT NULL,
    mrp_expected_paise BIGINT DEFAULT 0,
    discount_pct NUMERIC(5, 2) DEFAULT 0.0,
    gst_rate NUMERIC(5, 2) DEFAULT 12.0,
    supplier_scheme_id UUID REFERENCES supplier_schemes(id) ON DELETE SET NULL,
    scheme_summary TEXT,
    effective_cost_paise BIGINT NOT NULL,
    expected_expiry_threshold_days INTEGER DEFAULT 180,
    required_by_date VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_med ON purchase_order_items(medicine_id);

-- 8. PO Versions & Requisition Links
CREATE TABLE IF NOT EXISTS purchase_order_versions (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    snapshot_json JSONB NOT NULL,
    change_reason TEXT NOT NULL,
    changed_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_order_requisition_links (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_item_id UUID NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
    requisition_id UUID NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
    requisition_item_id UUID NOT NULL REFERENCES purchase_requisition_items(id) ON DELETE CASCADE,
    allocated_quantity NUMERIC(15, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 9. Goods Receipt Notes (GRN)
CREATE TABLE IF NOT EXISTS goods_receipts (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
    grn_number VARCHAR(100) NOT NULL,
    supplier_delivery_note VARCHAR(100),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    received_by VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, RECEIVING, REVIEW, POSTED, CANCELLED
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_grn_org_status ON goods_receipts(organization_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_receipts(po_id);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    grn_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
    po_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    manufacturing_date VARCHAR(50),
    expiry_date VARCHAR(50) NOT NULL,
    ordered_quantity NUMERIC(15, 4) DEFAULT 0,
    received_paid_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0,
    free_quantity NUMERIC(15, 4) DEFAULT 0,
    rejected_quantity NUMERIC(15, 4) DEFAULT 0,
    damaged_quantity NUMERIC(15, 4) DEFAULT 0,
    short_quantity NUMERIC(15, 4) DEFAULT 0,
    excess_quantity NUMERIC(15, 4) DEFAULT 0,
    accepted_quantity NUMERIC(15, 4) NOT NULL DEFAULT 0,
    purchase_rate_paise BIGINT NOT NULL,
    mrp_paise BIGINT NOT NULL DEFAULT 0,
    gst_rate NUMERIC(5, 2) DEFAULT 12.0,
    discount_pct NUMERIC(5, 2) DEFAULT 0.0,
    scheme_summary TEXT,
    effective_cost_paise BIGINT NOT NULL,
    rejection_reason TEXT,
    damage_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON goods_receipt_items(grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_batch ON goods_receipt_items(medicine_id, batch_number);

-- 10. Purchase Invoices & Three-Way Match
CREATE TABLE IF NOT EXISTS purchase_invoices (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
    grn_id UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100) NOT NULL,
    invoice_date VARCHAR(50) NOT NULL,
    due_date VARCHAR(50),
    payment_terms VARCHAR(50) DEFAULT 'NET_30',
    subtotal_paise BIGINT NOT NULL DEFAULT 0,
    discount_paise BIGINT NOT NULL DEFAULT 0,
    gst_paise BIGINT NOT NULL DEFAULT 0,
    round_off_paise BIGINT NOT NULL DEFAULT 0,
    total_paise BIGINT NOT NULL DEFAULT 0,
    paid_amount_paise BIGINT NOT NULL DEFAULT 0,
    balance_due_paise BIGINT NOT NULL DEFAULT 0,
    payment_status VARCHAR(50) DEFAULT 'UNPAID', -- UNPAID, PARTIALLY_PAID, PAID
    match_status VARCHAR(50) DEFAULT 'MATCHED', -- MATCHED, QUANTITY_VARIANCE, PRICE_VARIANCE, TAX_VARIANCE, SCHEME_VARIANCE, UNORDERED_ITEM, MISSING_GRN, DUPLICATE_ITEM, REVIEW_REQUIRED
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, MATCHED, POSTED, CANCELLED
    notes TEXT,
    bill_image_url TEXT,
    ocr_extracted_json JSONB,
    posted_by VARCHAR(100),
    posted_at TIMESTAMPTZ,
    created_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, supplier_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_pinv_org_supp ON purchase_invoices(organization_id, supplier_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_pinv_status ON purchase_invoices(status, payment_status);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    po_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
    grn_item_id UUID REFERENCES goods_receipt_items(id) ON DELETE SET NULL,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_number VARCHAR(100),
    quantity NUMERIC(15, 4) NOT NULL,
    free_quantity NUMERIC(15, 4) DEFAULT 0,
    purchase_rate_paise BIGINT NOT NULL,
    discount_pct NUMERIC(5, 2) DEFAULT 0.0,
    gst_rate NUMERIC(5, 2) DEFAULT 12.0,
    total_paise BIGINT NOT NULL,
    match_status VARCHAR(50) DEFAULT 'MATCHED',
    variance_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_match_results (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
    grn_id UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,
    match_status VARCHAR(50) NOT NULL,
    price_variance_paise BIGINT DEFAULT 0,
    price_variance_pct NUMERIC(5, 2) DEFAULT 0.0,
    quantity_variance NUMERIC(15, 4) DEFAULT 0,
    tax_variance_paise BIGINT DEFAULT 0,
    scheme_variance_summary TEXT,
    tolerance_applied BOOLEAN DEFAULT FALSE,
    is_exception BOOLEAN DEFAULT FALSE,
    exception_approved_by VARCHAR(100),
    exception_approved_at TIMESTAMPTZ,
    exception_reason TEXT,
    match_details_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 11. Supplier Payable Ledger & Payments
CREATE TABLE IF NOT EXISTS supplier_payable_ledger (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    transaction_type VARCHAR(50) NOT NULL, -- PURCHASE_INVOICE, PAYMENT, DEBIT_NOTE, CREDIT_ADJUSTMENT, OPENING_BALANCE, REVERSAL
    reference_id VARCHAR(100) NOT NULL,
    reference_number VARCHAR(100),
    invoice_id UUID REFERENCES purchase_invoices(id) ON DELETE SET NULL,
    debit_paise BIGINT NOT NULL DEFAULT 0, -- Increases liability or payments depending convention; standard: credit = invoice (liability), debit = payment/debit note
    credit_paise BIGINT NOT NULL DEFAULT 0,
    balance_after_paise BIGINT NOT NULL,
    notes TEXT,
    performed_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_supp_ledger ON supplier_payable_ledger(organization_id, supplier_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_payments (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    payment_number VARCHAR(100) NOT NULL,
    payment_date VARCHAR(50) NOT NULL,
    payment_mode VARCHAR(50) NOT NULL DEFAULT 'BANK_TRANSFER', -- BANK_TRANSFER, CASH, UPI, CHEQUE, NEFT_RTGS, OTHER
    reference_number VARCHAR(100),
    amount_paise BIGINT NOT NULL,
    unallocated_paise BIGINT NOT NULL DEFAULT 0,
    notes TEXT,
    recorded_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    allocated_amount_paise BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 12. Purchase Returns & Debit Notes
CREATE TABLE IF NOT EXISTS debit_notes (
    id UUID PRIMARY KEY,
    _local_id VARCHAR(100),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    debit_note_number VARCHAR(100) NOT NULL,
    return_id UUID,
    invoice_id UUID REFERENCES purchase_invoices(id) ON DELETE SET NULL,
    amount_paise BIGINT NOT NULL,
    gst_paise BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(50) DEFAULT 'ISSUED', -- ISSUED, APPLIED, CANCELLED
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
