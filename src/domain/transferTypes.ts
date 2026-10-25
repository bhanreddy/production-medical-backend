// transferTypes.ts — Multi-Store Transfers, Warehouse Operations & Central Replenishment Domain Types
import { LocationType } from './units';

export type TransferType =
  | 'STORE_TO_STORE'
  | 'WAREHOUSE_TO_STORE'
  | 'STORE_TO_WAREHOUSE'
  | 'WAREHOUSE_TO_WAREHOUSE'
  | 'RETURN_TO_SOURCE'
  | 'RECALL_TRANSFER'
  | 'EMERGENCY_TRANSFER'
  | 'REBALANCING';

export type TransferStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'ALLOCATING'
  | 'READY_TO_PICK'
  | 'PICKING'
  | 'PICKED'
  | 'PACKED'
  | 'DISPATCHED'
  | 'IN_TRANSIT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'VARIANCE_REVIEW'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REJECTED';

export type TransferPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | 'CRITICAL';

export type TransferSourceReason =
  | 'MANUAL'
  | 'REORDER_ENGINE'
  | 'WAREHOUSE_REPLENISHMENT'
  | 'STORE_REBALANCING'
  | 'STOCKOUT'
  | 'PRESCRIPTION_DEMAND'
  | 'SHORTBOOK'
  | 'NEAR_EXPIRY'
  | 'RECALL'
  | 'EMERGENCY';

export type TransferVarianceType =
  | 'SHORT'
  | 'EXCESS'
  | 'DAMAGED'
  | 'WRONG_PRODUCT'
  | 'WRONG_BATCH'
  | 'EXPIRED'
  | 'PACKAGE_MISSING'
  | 'COUNT_MISMATCH'
  | 'OTHER';

export type TransferVarianceResolution =
  | 'ACCEPT_VARIANCE'
  | 'RECOUNT'
  | 'SOURCE_CORRECTION'
  | 'DESTINATION_CORRECTION'
  | 'RETURN_TO_SOURCE'
  | 'STOCK_ADJUSTMENT'
  | 'INVESTIGATION';

export type TransferEventType =
  | 'CREATED'
  | 'REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'ALLOCATED'
  | 'PICK_STARTED'
  | 'ITEM_PICKED'
  | 'PICK_COMPLETE'
  | 'PACKED'
  | 'DISPATCHED'
  | 'PARTIAL_RECEIPT'
  | 'RECEIVED'
  | 'VARIANCE_REPORTED'
  | 'VARIANCE_RESOLVED'
  | 'CLOSED'
  | 'CANCELLED';

export interface LocationRef {
  type: LocationType;
  id: string;
  organizationId: string;
  code?: string;
  name?: string;
  address?: string | null;
  coldStorageSupported?: boolean;
}

export interface TransferPolicy {
  id?: string;
  organizationId: string;
  autoApproveRoutineTransfers: boolean;
  autoApproveValueLimitPaise: number;
  storeManagerApprovalLimitPaise: number;
  regionalManagerApprovalLimitPaise: number;
  enforceMakerChecker: boolean;
  requirePackVerification: boolean;
  requireFefoAllocation: boolean;
  minShelfLifeDaysTransfer: number;
  allowPartialReceipt: boolean;
  autoCloseOnExactReceipt: boolean;
}

export interface StockTransfer {
  id: string;
  _local_id?: string;
  organization_id: string;
  transfer_number: string;
  transfer_type: TransferType;
  source_location_type: LocationType;
  source_location_id: string;
  destination_location_type: LocationType;
  destination_location_id: string;
  source_name?: string;
  destination_name?: string;
  priority: TransferPriority;
  reason: TransferSourceReason;
  status: TransferStatus;
  stock_state_transferred: 'AVAILABLE' | 'QUARANTINED' | 'RECALLED' | 'DAMAGED';
  total_items: number;
  total_quantity_requested: number;
  total_quantity_dispatched: number;
  total_quantity_received: number;
  total_value_paise: number;
  requested_by: string;
  requested_at: string;
  required_by_date?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  pick_started_at?: string | null;
  picked_by?: string | null;
  picked_at?: string | null;
  packed_by?: string | null;
  packed_at?: string | null;
  package_count: number;
  is_cold_chain: boolean;
  carrier_name?: string | null;
  tracking_reference?: string | null;
  dispatched_by?: string | null;
  dispatched_at?: string | null;
  estimated_arrival_at?: string | null;
  received_by?: string | null;
  received_at?: string | null;
  completed_at?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  created_at?: string;
  updated_at?: string;
  items?: StockTransferItem[];
  allocations?: StockTransferBatchAllocation[];
  packages?: TransferPackage[];
  receipts?: TransferReceipt[];
  variances?: TransferVariance[];
  events?: TransferEvent[];
}

export interface StockTransferItem {
  id: string;
  _local_id?: string;
  transfer_id: string;
  organization_id: string;
  medicine_id: string;
  medicine_name?: string;
  requested_unit: string;
  conversion_factor: number;
  requested_quantity: number;
  base_quantity_requested: number;
  allocated_quantity: number;
  picked_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  damaged_quantity: number;
  short_quantity: number;
  excess_quantity: number;
  rejected_quantity: number;
  unit_cost_paise: number;
  total_value_paise: number;
  source_stock_snapshot: number;
  destination_stock_snapshot: number;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  allocations?: StockTransferBatchAllocation[];
}

export interface StockTransferBatchAllocation {
  id: string;
  _local_id?: string;
  transfer_id: string;
  transfer_item_id: string;
  organization_id: string;
  medicine_id: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  unit_cost_paise: number;
  mrp_paise: number;
  quantity_allocated: number;
  quantity_picked: number;
  quantity_dispatched: number;
  quantity_received: number;
  quantity_damaged: number;
  quantity_short: number;
  quantity_excess: number;
  reservation_id?: string | null;
  source_bin_id?: string | null;
  destination_bin_id?: string | null;
  is_picked: boolean;
  picked_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TransferPackage {
  id: string;
  _local_id?: string;
  transfer_id: string;
  organization_id: string;
  package_identifier: string;
  package_number: number;
  package_type: 'BOX' | 'BAG' | 'CONTAINER' | 'COLD_BOX' | 'PALLET';
  is_cold_chain: boolean;
  packed_by: string;
  packed_at: string;
  weight_kg?: number | null;
  special_instructions?: string | null;
  seal_number?: string | null;
  created_at?: string;
  items?: TransferPackageItem[];
}

export interface TransferPackageItem {
  id: string;
  _local_id?: string;
  package_id: string;
  transfer_id: string;
  transfer_item_id: string;
  batch_allocation_id: string;
  medicine_id: string;
  batch_id: string;
  quantity_packed: number;
  created_at?: string;
}

export interface TransferReceipt {
  id: string;
  _local_id?: string;
  transfer_id: string;
  organization_id: string;
  receipt_number: string;
  received_by: string;
  received_at: string;
  status: 'DRAFT' | 'COMPLETED' | 'VARIANCE_HOLD';
  condition_status: 'GOOD' | 'DAMAGED_PACKAGING' | 'TEMPERATURE_BREACH' | 'TAMPERED';
  notes?: string | null;
  idempotency_key?: string | null;
  created_at?: string;
  items?: TransferReceiptItem[];
}

export interface TransferReceiptItem {
  id: string;
  _local_id?: string;
  receipt_id: string;
  transfer_id: string;
  transfer_item_id: string;
  batch_allocation_id: string;
  medicine_id: string;
  batch_id: string;
  quantity_dispatched: number;
  quantity_accepted: number;
  quantity_damaged: number;
  quantity_short: number;
  quantity_excess: number;
  quantity_rejected: number;
  destination_bin_id?: string | null;
  damage_notes?: string | null;
  created_at?: string;
}

export interface TransferVariance {
  id: string;
  _local_id?: string;
  transfer_id: string;
  receipt_id?: string | null;
  organization_id: string;
  medicine_id: string;
  batch_id: string;
  variance_type: TransferVarianceType;
  expected_quantity: number;
  actual_quantity: number;
  variance_quantity: number;
  unit_cost_paise: number;
  variance_value_paise: number;
  status: 'REPORTED' | 'INVESTIGATING' | 'APPROVED' | 'RESOLVED' | 'REJECTED';
  resolution?: TransferVarianceResolution | null;
  resolution_notes?: string | null;
  reported_by: string;
  reported_at: string;
  resolved_by?: string | null;
  resolved_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TransferEvent {
  id: string;
  _local_id?: string;
  transfer_id: string;
  organization_id: string;
  event_type: TransferEventType;
  from_status?: string | null;
  to_status?: string | null;
  performed_by: string;
  performer_name?: string | null;
  details_json?: any;
  notes?: string | null;
  created_at?: string;
}

export interface WarehouseBin {
  id: string;
  _local_id?: string;
  organization_id: string;
  warehouse_id: string;
  parent_bin_id?: string | null;
  bin_code: string;
  bin_name: string;
  zone?: string | null;
  rack?: string | null;
  shelf?: string | null;
  bin_type: 'STORAGE' | 'STAGING' | 'PICKING' | 'PACKING' | 'COLD_ROOM' | 'QUARANTINE' | 'RECALL' | 'DAMAGE';
  pick_sequence: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface InventoryBinPosition {
  id: string;
  _local_id?: string;
  organization_id: string;
  warehouse_id: string;
  bin_id: string;
  medicine_id: string;
  batch_id: string;
  quantity: number;
  created_at?: string;
  updated_at?: string;
}

export interface ReplenishmentDecision {
  medicineId: string;
  medicineName: string;
  destinationStoreId: string;
  destinationStoreName: string;
  currentAvailableStock: number;
  daysOfCover: number;
  targetStock: number;
  deficitQuantity: number;
  incomingQuantity: number;
  netRequiredQuantity: number;
  decisionType:
    | 'NO_ACTION'
    | 'WAREHOUSE_TRANSFER'
    | 'STORE_REBALANCE'
    | 'EXTERNAL_PROCUREMENT'
    | 'WAIT_FOR_INCOMING'
    | 'REVIEW_REQUIRED';
  suggestedSourceLocationType?: LocationType;
  suggestedSourceLocationId?: string;
  suggestedSourceLocationName?: string;
  suggestedSourceAvailableStock?: number;
  recommendedTransferQuantity?: number;
  priority: TransferPriority;
  reason: string;
}

export interface RebalancingRecommendation {
  medicineId: string;
  medicineName: string;
  sourceStoreId: string;
  sourceStoreName: string;
  sourceOnHand: number;
  sourceAvailable: number;
  sourceDailyDemand: number;
  sourceProtectedStock: number;
  sourceTransferableQuantity: number;
  destinationStoreId: string;
  destinationStoreName: string;
  destinationOnHand: number;
  destinationDailyDemand: number;
  destinationDaysCover: number;
  recommendedTransferQuantity: number;
  priority: TransferPriority;
}

export interface ExpiryRedistributionPlan {
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  daysUntilExpiry: number;
  sourceStoreId: string;
  sourceStoreName: string;
  sourceQuantity: number;
  sourceDailyDemand: number;
  sourceProjectedConsumption: number;
  sourceAtRiskQuantity: number;
  destinationStoreId: string;
  destinationStoreName: string;
  destinationDailyDemand: number;
  destinationCapacityBeforeExpiry: number;
  recommendedTransferQuantity: number;
  isFeasible: boolean;
  reason: string;
}
