-- Migration 009: Prescription Management, Pharmacist Verification & Pharmacy Safety Engine

-- 1. Doctor Master
CREATE TABLE IF NOT EXISTS doctors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    registration_number VARCHAR(100) NOT NULL,
    registration_authority VARCHAR(255),
    specialization VARCHAR(255),
    phone VARCHAR(50),
    clinic_hospital VARCHAR(255),
    address TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_doctors_org_name ON doctors(organization_id, name);
CREATE INDEX IF NOT EXISTS idx_doctors_reg_no ON doctors(registration_number);

-- 2. Prescriptions
CREATE TABLE IF NOT EXISTS prescriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    patient_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    prescription_number VARCHAR(100) NOT NULL,
    external_rx_number VARCHAR(100),
    doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
    doctor_name_snapshot VARCHAR(255) NOT NULL,
    doctor_registration_number_snapshot VARCHAR(100) NOT NULL,
    prescribed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP WITH TIME ZONE,
    document_url TEXT NOT NULL,
    document_hash VARCHAR(64),
    source VARCHAR(50) NOT NULL DEFAULT 'FILE_UPLOAD',
    status VARCHAR(50) NOT NULL DEFAULT 'NEEDS_REVIEW',
    verification_status VARCHAR(50) NOT NULL DEFAULT 'UNVERIFIED',
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at TIMESTAMP WITH TIME ZONE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE,
    rejection_reason VARCHAR(255),
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_org_status ON prescriptions(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prescriptions_store_status ON prescriptions(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id, prescribed_at DESC);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doc_hash ON prescriptions(document_hash);

-- 3. Prescription Items
CREATE TABLE IF NOT EXISTS prescription_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    sequence INT NOT NULL DEFAULT 1,
    raw_text TEXT NOT NULL,
    matched_product_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
    generic_name VARCHAR(255),
    prescribed_name VARCHAR(255) NOT NULL,
    strength VARCHAR(100),
    dosage_form VARCHAR(100),
    dose_text VARCHAR(100),
    frequency_text VARCHAR(100),
    duration_text VARCHAR(100),
    prescribed_quantity INT NOT NULL DEFAULT 1,
    dispensed_quantity INT NOT NULL DEFAULT 0,
    repeats_authorized INT NOT NULL DEFAULT 0,
    repeats_used INT NOT NULL DEFAULT 0,
    repeat_interval_days INT,
    repeats_valid_until TIMESTAMP WITH TIME ZONE,
    substitution_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    match_status VARCHAR(50) NOT NULL DEFAULT 'UNMATCHED',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prescription_items_rx_seq ON prescription_items(prescription_id, sequence);

-- 4. Dispensing Events
CREATE TABLE IF NOT EXISTS dispensing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    terminal_id UUID REFERENCES terminals(id) ON DELETE SET NULL,
    prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    prescription_item_id UUID NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    sale_item_id UUID REFERENCES sale_items(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
    quantity_dispensed INT NOT NULL,
    base_unit_quantity INT NOT NULL DEFAULT 1,
    dispensed_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dispensed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dispensing_rx_id ON dispensing_events(prescription_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_rx_item ON dispensing_events(prescription_item_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_sale_id ON dispensing_events(sale_id);

-- 5. Patient Allergies
CREATE TABLE IF NOT EXISTS patient_allergies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    allergen VARCHAR(255) NOT NULL,
    allergen_type VARCHAR(50) NOT NULL DEFAULT 'INGREDIENT',
    reaction_text TEXT,
    severity VARCHAR(50) NOT NULL DEFAULT 'MODERATE',
    recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    source VARCHAR(100) DEFAULT 'MANUAL_ENTRY',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient ON patient_allergies(patient_id, active);

-- 6. Safety Warning Events
CREATE TABLE IF NOT EXISTS safety_warning_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    warning_type VARCHAR(50) NOT NULL,
    severity VARCHAR(50) NOT NULL,
    warning_text TEXT NOT NULL,
    acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action_taken VARCHAR(100),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);

-- 7. Substitution Events
CREATE TABLE IF NOT EXISTS substitution_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _local_id VARCHAR(64) UNIQUE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    prescription_item_id UUID NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    prescribed_product_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
    prescribed_name VARCHAR(255) NOT NULL,
    dispensed_product_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    dispensed_name VARCHAR(255) NOT NULL,
    substituted_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    customer_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    doctor_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _deleted INT NOT NULL DEFAULT 0
);
