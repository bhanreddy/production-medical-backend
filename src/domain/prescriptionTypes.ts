export type PrescriptionSource =
  | 'PAPER_CAPTURE'
  | 'FILE_UPLOAD'
  | 'CUSTOMER_UPLOAD'
  | 'WHATSAPP_IMPORT'
  | 'DOCTOR_UPLOAD'
  | 'HOSPITAL_SYSTEM'
  | 'MANUAL_ENTRY';

export type PrescriptionStatus =
  | 'UPLOADED'
  | 'DRAFT'
  | 'NEEDS_REVIEW'
  | 'VERIFIED'
  | 'PARTIALLY_DISPENSED'
  | 'DISPENSED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type VerificationStatus =
  | 'UNVERIFIED'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'REJECTED';

export type ItemMatchStatus =
  | 'UNMATCHED'
  | 'AUTO_MATCHED'
  | 'MANUALLY_MATCHED'
  | 'VERIFIED'
  | 'IGNORED';

export type RejectionReason =
  | 'UNREADABLE'
  | 'EXPIRED'
  | 'INVALID'
  | 'MISSING_DOCTOR_DETAILS'
  | 'MEDICINE_UNCLEAR'
  | 'PRESCRIPTION_REQUIRED'
  | 'DUPLICATE_SUSPECTED'
  | 'OTHER';

export type RefillEligibility =
  | 'NOT_ELIGIBLE'
  | 'ELIGIBLE_NOW'
  | 'ELIGIBLE_FROM_DATE'
  | 'EXHAUSTED'
  | 'EXPIRED'
  | 'REVIEW_REQUIRED';

export type AllergenType = 'INGREDIENT' | 'DRUG_CLASS' | 'FOOD' | 'OTHER';
export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'ANAPHYLAXIS';

export type WarningSeverity = 'INFO' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CONTRAINDICATED';

export type SubstitutionPolicy =
  | 'NOT_ALLOWED'
  | 'ALLOWED'
  | 'PHARMACIST_APPROVAL_REQUIRED'
  | 'CUSTOMER_CONFIRMATION_REQUIRED'
  | 'DOCTOR_CONFIRMATION_REQUIRED';

export interface Doctor {
  id?: string;
  _local_id?: string;
  organization_id?: string | null;
  name: string;
  registration_number: string;
  registration_authority?: string | null;
  specialization?: string | null;
  phone?: string | null;
  clinic_hospital?: string | null;
  address?: string | null;
  active?: boolean;
  created_at?: string;
  _updated_at?: string;
  _deleted?: number;
}

export interface Prescription {
  id?: string;
  _local_id?: string;
  organization_id: string;
  store_id?: string | null;
  patient_id?: string | null;
  prescription_number: string;
  external_rx_number?: string | null;
  doctor_id?: string | null;
  doctor_name_snapshot: string;
  doctor_registration_number_snapshot: string;
  prescribed_at: string;
  valid_from: string;
  valid_until?: string | null;
  document_url: string;
  document_hash?: string | null;
  source: PrescriptionSource;
  status: PrescriptionStatus;
  verification_status: VerificationStatus;
  verified_by?: string | null;
  verified_at?: string | null;
  assigned_to?: string | null;
  assigned_at?: string | null;
  rejection_reason?: RejectionReason | string | null;
  notes?: string | null;
  created_by?: string | null;
  created_at?: string;
  _updated_at?: string;
  _deleted?: number;
  items?: PrescriptionItem[];
}

export interface PrescriptionItem {
  id?: string;
  _local_id?: string;
  prescription_id: string;
  sequence: number;
  raw_text: string;
  matched_product_id?: string | null;
  generic_name?: string | null;
  prescribed_name: string;
  strength?: string | null;
  dosage_form?: string | null;
  dose_text?: string | null;
  frequency_text?: string | null;
  duration_text?: string | null;
  prescribed_quantity: number;
  dispensed_quantity: number;
  repeats_authorized: number;
  repeats_used: number;
  repeat_interval_days?: number | null;
  repeats_valid_until?: string | null;
  substitution_allowed: boolean;
  notes?: string | null;
  match_status: ItemMatchStatus;
  created_at?: string;
  _updated_at?: string;
  _deleted?: number;
}

export interface DispensingEvent {
  id?: string;
  _local_id?: string;
  organization_id: string;
  store_id: string;
  terminal_id?: string | null;
  prescription_id: string;
  prescription_item_id: string;
  sale_id?: string | null;
  sale_item_id?: string | null;
  product_id: string;
  batch_id: string;
  quantity_dispensed: number;
  base_unit_quantity: number;
  dispensed_by: string;
  dispensed_at: string;
  created_at?: string;
  _updated_at?: string;
  _deleted?: number;
}

export interface PatientAllergy {
  id?: string;
  _local_id?: string;
  organization_id: string;
  patient_id: string;
  allergen: string;
  allergen_type: AllergenType;
  reaction_text?: string | null;
  severity: AllergySeverity;
  recorded_by?: string | null;
  source?: string;
  active?: boolean;
  created_at?: string;
  _updated_at?: string;
  _deleted?: number;
}

export interface SafetyWarningEvent {
  id?: string;
  _local_id?: string;
  organization_id: string;
  store_id?: string | null;
  prescription_id?: string | null;
  sale_id?: string | null;
  warning_type: string;
  severity: WarningSeverity;
  warning_text: string;
  acknowledged_by?: string | null;
  acknowledged_at?: string;
  action_taken?: string | null;
  reason?: string | null;
  created_at?: string;
}

export interface SubstitutionEvent {
  id?: string;
  _local_id?: string;
  organization_id: string;
  prescription_id: string;
  prescription_item_id: string;
  sale_id?: string | null;
  prescribed_product_id?: string | null;
  prescribed_name: string;
  dispensed_product_id: string;
  dispensed_name: string;
  substituted_by: string;
  reason: string;
  customer_confirmed: boolean;
  doctor_confirmed: boolean;
  created_at?: string;
}

export interface ExtractedCandidate {
  raw_text: string;
  prescribed_name: string;
  suggested_product_id?: string | null;
  suggested_product_name?: string | null;
  generic_name?: string | null;
  strength?: string | null;
  dosage_form?: string | null;
  dose_text?: string | null;
  frequency_text?: string | null;
  duration_text?: string | null;
  suggested_quantity?: number | null;
  confidence: number;
}
