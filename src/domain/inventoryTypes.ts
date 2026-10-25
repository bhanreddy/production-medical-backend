// inventoryTypes.ts — Task 5 Domain Types

export type InventoryState =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'QUARANTINED'
  | 'DAMAGED'
  | 'EXPIRED'
  | 'RECALLED'
  | 'IN_TRANSIT'
  | 'ON_HOLD'
  | 'DISPOSED'
  | 'LOST'
  | 'STOCKTAKE_LOCKED';

export type StocktakeType =
  | 'FULL'
  | 'CATEGORY'
  | 'PRODUCT_RANGE'
  | 'BATCH'
  | 'LOCATION'
  | 'CYCLE_COUNT'
  | 'HIGH_VALUE'
  | 'EXPIRY'
  | 'RANDOM';

export type CountingMode = 'HARD_FREEZE' | 'SOFT_FREEZE' | 'LIVE_COUNT';

export type StocktakeStatus =
  | 'DRAFT'
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'COUNTING_COMPLETE'
  | 'REVIEW'
  | 'APPROVED'
  | 'POSTED'
  | 'CANCELLED';

export type VarianceReason =
  | 'COUNT_ERROR'
  | 'DAMAGE'
  | 'LOSS'
  | 'THEFT_SUSPECTED'
  | 'UNRECORDED_RETURN'
  | 'UNRECORDED_PURCHASE'
  | 'WRONG_BATCH'
  | 'EXPIRY'
  | 'SYSTEM_MISMATCH'
  | 'OTHER';

export type RecallType = 'PRODUCT' | 'BATCH' | 'MANUFACTURER_LOT';
export type RecallSeverity = 'CLASS_I' | 'CLASS_II' | 'CLASS_III';
export type RecallStatus = 'DRAFT' | 'ACTIVE' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type RecallTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'QUARANTINED' | 'COMPLETED';

export type ReservationSourceType =
  | 'PARKED_SALE'
  | 'PRESCRIPTION'
  | 'ONLINE_ORDER'
  | 'CLICK_COLLECT'
  | 'ORDER'
  | 'TRANSFER'
  | 'MANUAL';

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED' | 'CANCELLED';

export type AlertType =
  | 'LOW_STOCK'
  | 'STOCKOUT'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'DEAD_STOCK'
  | 'HIGH_VARIANCE'
  | 'RECALL'
  | 'RECONCILIATION_MISMATCH'
  | 'EXCESS_STOCK'
  | 'RESERVATION_STUCK';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

export type ABCClass = 'A' | 'B' | 'C';
export type MovementClass = 'FAST_MOVING' | 'NORMAL' | 'SLOW_MOVING' | 'NON_MOVING' | 'DEAD_STOCK';

export type ExpiryActionRecommendation =
  | 'SELL_THROUGH'
  | 'RETURN_TO_SUPPLIER'
  | 'TRANSFER_CANDIDATE'
  | 'PROMOTION_CANDIDATE'
  | 'QUARANTINE'
  | 'DISPOSE';

export type ReplenishmentType =
  | 'SUPPLIER_PURCHASE'
  | 'WAREHOUSE_REPLENISHMENT_CANDIDATE'
  | 'STORE_REBALANCE_CANDIDATE';

export interface InventoryPositionBreakdown {
  id: string;
  organizationId: string;
  medicineId: string;
  batchId: string;
  locationType: 'STORE' | 'WAREHOUSE';
  storeId: string | null;
  warehouseId: string | null;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityReserved: number;
  quantityQuarantined: number;
  quantityDamaged: number;
  quantityRecalled: number;
  quantityInTransit: number;
  quantityOnHold: number;
  quantityStocktakeLocked: number;
  updatedAt: string;
}

export interface BatchAvailabilitySummary {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityReserved: number;
  isExpired: boolean;
  isRecalled: boolean;
  isQuarantined: boolean;
  isDamaged: boolean;
  isStocktakeLocked: boolean;
  unitCostPaise: number;
  mrpPaise: number;
}

export interface InventoryAvailabilityResult {
  medicineId: string;
  medicineName?: string;
  organizationId: string;
  locationType: 'STORE' | 'WAREHOUSE';
  storeId: string | null;
  warehouseId: string | null;
  totalOnHand: number;
  totalAvailable: number;
  totalReserved: number;
  totalBlocked: number;
  totalInTransit: number;
  batches: BatchAvailabilitySummary[];
  sellableBatches: BatchAvailabilitySummary[];
  nearestExpiryDate: string | null;
  stockState: InventoryState;
  warnings: string[];
}

export interface StocktakeSessionRecord {
  id: string;
  organization_id: string;
  store_id: string | null;
  warehouse_id: string | null;
  name: string;
  type: StocktakeType;
  scope: any;
  counting_mode: CountingMode;
  is_blind_count: boolean;
  is_double_count: boolean;
  status: StocktakeStatus;
  initiated_by: string;
  approved_by?: string | null;
  reference_timestamp: string;
  started_at?: string | null;
  completed_at?: string | null;
  approved_at?: string | null;
  posted_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface StocktakeItemRecord {
  id: string;
  stocktake_id: string;
  organization_id: string;
  medicine_id: string;
  batch_id: string | null;
  batch_number?: string | null;
  expiry_date?: string | null;
  expected_quantity: number;
  physical_quantity: number;
  difference: number;
  unit_cost_paise: number;
  value_difference_paise: number;
  variance_reason?: VarianceReason | null;
  recount_status: 'NONE' | 'REQUESTED' | 'COMPLETED' | 'CONFLICT';
  recount_count_a?: number | null;
  recount_count_b?: number | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReorderRecommendationResult {
  medicineId: string;
  medicineName: string;
  organizationId: string;
  storeId: string | null;
  availableStock: number;
  reservedStock: number;
  incomingPoStock: number;
  avgDailyDemand: number;
  leadTimeDays: number;
  safetyStockUnits: number;
  daysOfCover: number;
  reorderPoint: number;
  calculatedDeficit: number;
  recommendedQuantity: number;
  recommendedType: ReplenishmentType;
  packSize: number;
  minimumOrderQuantity: number;
  reason: string;
  confidenceScore: number;
  warehouseAvailableUnits?: number;
  alternativeStoreSurplusUnits?: { storeId: string; storeName: string; surplusUnits: number }[];
}

export interface ShortbookConsolidatedItem {
  medicineId: string;
  medicineName: string;
  genericName?: string;
  totalQuantityNeeded: number;
  requestCount: number;
  customerRequestCount: number;
  prescriptionShortageCount: number;
  firstRequestedAt: string;
  lastRequestedAt: string;
  sources: string[];
  preferredSupplierId?: string | null;
  preferredSupplierName?: string | null;
}
