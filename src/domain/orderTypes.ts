// orderTypes.ts — Enterprise Omnichannel Order Management & Fulfilment Domain Types
import { ProductUnit } from './units';
import { CommercialQuoteResult } from './commercialTypes';

export type OrderSource =
  | 'POS_ASSISTED'
  | 'PHONE'
  | 'WHATSAPP'
  | 'WEB'
  | 'MOBILE_APP'
  | 'REPEAT_ORDER'
  | 'PRESCRIPTION_UPLOAD'
  | 'CLICK_COLLECT'
  | 'DELIVERY'
  | 'API'
  | 'MANUAL';

export type OrderChannel =
  | 'RETAIL'
  | 'ECOMMERCE'
  | 'B2B'
  | 'CALL_CENTER'
  | 'PARTNER_APP';

export type FulfilmentType =
  | 'STORE_PICKUP'
  | 'CLICK_COLLECT'
  | 'HOME_DELIVERY'
  | 'COUNTER_PICKUP';

export type OrderStatus =
  | 'DRAFT'
  | 'CREATED'
  | 'VALIDATING'
  | 'PRESCRIPTION_PENDING'
  | 'CONFIRMED'
  | 'INVENTORY_RESERVED'
  | 'PICKING'
  | 'PACKED'
  | 'READY_FOR_PICKUP'
  | 'READY_FOR_DISPATCH'
  | 'PARTIALLY_FULFILLED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type OrderPrescriptionStatus =
  | 'NOT_REQUIRED'
  | 'PENDING_UPLOAD'
  | 'PENDING_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED';

export type OrderPaymentStatus =
  | 'UNPAID'
  | 'PAYMENT_PENDING'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'PAYMENT_DUE_ON_DELIVERY'
  | 'PAYMENT_FAILED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

export type OrderFulfilmentStatus =
  | 'UNASSIGNED'
  | 'ASSIGNED'
  | 'RESERVED'
  | 'PICKING'
  | 'PICKED'
  | 'PACKED'
  | 'READY'
  | 'DISPATCHED'
  | 'HANDED_OVER'
  | 'CANCELLED'
  | 'FAILED';

export type OrderPriority = 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL';

export type OrderItemStatus =
  | 'REQUESTED'
  | 'PENDING_VALIDATION'
  | 'PENDING_PRESCRIPTION'
  | 'CONFIRMED'
  | 'RESERVED'
  | 'PICKING'
  | 'PICKED'
  | 'SUBSTITUTION_REQUIRED'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'UNAVAILABLE';

export type SubstitutionPolicy =
  | 'NO_SUBSTITUTION'
  | 'CONTACT_ME'
  | 'ALLOW_EQUIVALENT_NON_PRESCRIPTION';

export type OrderCancellationReason =
  | 'CUSTOMER_REQUEST'
  | 'PAYMENT_FAILED'
  | 'OUT_OF_STOCK'
  | 'PRESCRIPTION_REJECTED'
  | 'NO_RESPONSE'
  | 'FULFILMENT_FAILURE'
  | 'DUPLICATE_ORDER'
  | 'STORE_UNAVAILABLE'
  | 'OTHER';

export type OrderEventType =
  | 'ORDER_CREATED'
  | 'ORDER_CONFIRMED'
  | 'PRESCRIPTION_SUBMITTED'
  | 'PRESCRIPTION_VERIFIED'
  | 'PRESCRIPTION_REJECTED'
  | 'INVENTORY_RESERVED'
  | 'RESERVATION_RELEASED'
  | 'PICK_STARTED'
  | 'ITEM_PICKED'
  | 'PICK_SHORTAGE'
  | 'PICK_COMPLETED'
  | 'PACKED'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'READY_FOR_DISPATCH'
  | 'DISPATCHED'
  | 'HANDED_OVER'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  | 'SUBSTITUTION_REQUESTED'
  | 'SUBSTITUTION_APPROVED'
  | 'SUBSTITUTION_REJECTED'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILMENT_REASSIGNED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'REFUND_INITIATED'
  | 'REFUNDED'
  | 'FAILED';

export interface CustomerAddress {
  id: string;
  organization_id: string;
  customer_id: string;
  label?: string | null;
  recipient_name: string;
  phone: string;
  address_line_1: string;
  address_line_2?: string | null;
  locality?: string | null;
  city: string;
  state: string;
  state_code?: string | null;
  pincode: string;
  landmark?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  is_default: boolean | number;
  delivery_instructions?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderAddressSnapshot {
  id: string;
  order_id: string;
  organization_id: string;
  address_id?: string | null;
  recipient_name: string;
  phone: string;
  address_line_1: string;
  address_line_2?: string | null;
  locality?: string | null;
  city: string;
  state: string;
  state_code?: string | null;
  pincode: string;
  landmark?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  delivery_instructions?: string | null;
  created_at?: string;
  _local_id?: string;
}

export interface Order {
  id: string;
  organization_id: string;
  order_number: string;
  customer_id: string;
  patient_id?: string | null;
  source: OrderSource;
  channel: OrderChannel;
  fulfilment_type: FulfilmentType;
  requested_store_id?: string | null;
  fulfilment_store_id?: string | null;
  fulfilment_warehouse_id?: string | null;
  status: OrderStatus;
  prescription_status: OrderPrescriptionStatus;
  payment_status: OrderPaymentStatus;
  fulfilment_status: OrderFulfilmentStatus;
  priority: OrderPriority;
  customer_notes?: string | null;
  internal_notes?: string | null;
  subtotal_paise: number;
  subtotal: number;
  discount_total_paise: number;
  discount_total: number;
  tax_total_paise: number;
  tax_total: number;
  loyalty_redemption_paise: number;
  loyalty_redemption_credits: number;
  delivery_charge_paise: number;
  delivery_charge: number;
  round_off_paise: number;
  round_off: number;
  grand_total_paise: number;
  grand_total: number;
  commercial_snapshot_id?: string | null;
  pickup_code?: string | null;
  pickup_code_hash?: string | null;
  pickup_verified_at?: string | null;
  pickup_verified_by?: string | null;
  sale_id?: string | null;
  idempotency_key?: string | null;
  quote_expires_at?: string | null;
  requested_fulfilment_at?: string | null;
  placed_at?: string | null;
  confirmed_at?: string | null;
  ready_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: OrderCancellationReason | string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  organization_id: string;
  medicine_id: string;
  medicine_name: string;
  requested_unit: ProductUnit | string;
  conversion_factor: number;
  requested_quantity: number;
  base_quantity: number;
  fulfilled_quantity: number;
  cancelled_quantity: number;
  substituted_quantity: number;
  prescription_required: boolean | number;
  prescription_item_id?: string | null;
  prescription_id?: string | null;
  requested_product_snapshot?: string | null;
  mrp_paise: number;
  unit_price_paise: number;
  discount_amount_paise: number;
  taxable_amount_paise: number;
  tax_amount_paise: number;
  gst_rate: number;
  line_total_paise: number;
  status: OrderItemStatus;
  substitution_policy: SubstitutionPolicy;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderFulfilmentGroup {
  id: string;
  order_id: string;
  organization_id: string;
  fulfilment_group_number: number;
  fulfilment_type: FulfilmentType;
  location_type: 'STORE' | 'WAREHOUSE';
  store_id?: string | null;
  warehouse_id?: string | null;
  status: OrderFulfilmentStatus;
  priority: OrderPriority;
  assigned_at?: string | null;
  pick_started_at?: string | null;
  picked_at?: string | null;
  packed_at?: string | null;
  ready_at?: string | null;
  dispatched_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderFulfilmentItem {
  id: string;
  fulfilment_id: string;
  order_id: string;
  order_item_id: string;
  organization_id: string;
  medicine_id: string;
  batch_id?: string | null;
  quantity_allocated: number;
  quantity_picked: number;
  quantity_packed: number;
  reservation_id?: string | null;
  status: OrderItemStatus;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderPackage {
  id: string;
  order_id: string;
  fulfilment_id: string;
  organization_id: string;
  package_number: number;
  package_label: string;
  package_type: string;
  is_cold_chain: boolean | number;
  is_prescription_required: boolean | number;
  packed_by: string;
  packed_at: string;
  special_instructions?: string | null;
  seal_number?: string | null;
  weight_kg?: number | null;
  created_at?: string;
  _local_id?: string;
}

export interface OrderPackageItem {
  id: string;
  package_id: string;
  order_id: string;
  fulfilment_id: string;
  order_item_id: string;
  medicine_id: string;
  batch_id?: string | null;
  quantity: number;
  created_at?: string;
  _local_id?: string;
}

export interface OrderSubstitution {
  id: string;
  order_id: string;
  order_item_id: string;
  organization_id: string;
  original_medicine_id: string;
  original_medicine_name: string;
  suggested_medicine_id: string;
  suggested_medicine_name: string;
  original_unit_price_paise: number;
  suggested_unit_price_paise: number;
  price_difference_paise: number;
  quantity: number;
  reason: string;
  requested_by: string;
  customer_confirmed: boolean | number;
  customer_confirmed_at?: string | null;
  pharmacist_verified: boolean | number;
  pharmacist_verified_by?: string | null;
  pharmacist_verified_at?: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'APPLIED';
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderRefund {
  id: string;
  order_id: string;
  organization_id: string;
  payment_transaction_id?: string | null;
  amount_paise: number;
  amount: number;
  reason: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  refund_reference?: string | null;
  processed_by?: string | null;
  processed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  _local_id?: string;
}

export interface OrderEvent {
  id: string;
  order_id: string;
  fulfilment_id?: string | null;
  organization_id: string;
  event_type: OrderEventType;
  from_status?: string | null;
  to_status?: string | null;
  actor_id?: string | null;
  actor_name?: string | null;
  details_json?: string | null;
  notes?: string | null;
  created_at?: string;
  _local_id?: string;
}

export interface OrderTransferLink {
  id: string;
  order_id: string;
  order_item_id?: string | null;
  transfer_id: string;
  organization_id: string;
  status: string;
  created_at?: string;
  _local_id?: string;
}

export interface FulfilmentCandidate {
  locationType: 'STORE' | 'WAREHOUSE';
  locationId: string;
  locationCode: string;
  locationName: string;
  address?: string | null;
  distanceKm: number;
  isOpen: boolean;
  fulfilmentEnabled: boolean;
  deliveryEnabled: boolean;
  clickCollectEnabled: boolean;
  coldChainSupported: boolean;
  pharmacistAvailable: boolean;
  activeOrderCount: number;
  availabilityPct: number;
  fullyAvailable: boolean;
  isEligible: boolean;
  ineligibilityReasons?: string[];
  availableItemsCount: number;
  totalItemsCount: number;
  score: number;
  itemAvailabilities: Array<{
    medicineId: string;
    medicineName: string;
    requestedQuantity: number;
    availableQuantity: number;
    isAvailable: boolean;
  }>;
}
