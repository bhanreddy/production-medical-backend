/**
 * Enterprise Unit, Product & Movement Domain Definitions
 */

export const PRODUCT_UNITS = [
  'BOX',
  'PACK',
  'STRIP',
  'TABLET',
  'CAPSULE',
  'BOTTLE',
  'VIAL',
  'AMPOULE',
  'TUBE',
  'SACHET',
  'UNIT',
] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export const PRODUCT_TYPES = [
  'MEDICINE',
  'OTC',
  'SURGICAL',
  'MEDICAL_DEVICE',
  'FMCG',
  'WELLNESS',
  'COSMETIC',
  'PERSONAL_CARE',
  'CONSUMABLE',
  'OTHER',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const SCHEDULE_CLASSIFICATIONS = [
  'NONE',
  'SCHEDULE_H',
  'SCHEDULE_H1',
  'SCHEDULE_X',
  'NARCOTIC',
] as const;
export type ScheduleClassification = (typeof SCHEDULE_CLASSIFICATIONS)[number];

export const BARCODE_TYPES = [
  'MANUFACTURER',
  'INTERNAL',
  'PACK',
  'STRIP',
  'UNIT',
] as const;
export type BarcodeType = (typeof BARCODE_TYPES)[number];

export const LOCATION_TYPES = ['STORE', 'WAREHOUSE'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const DOCUMENT_TYPES = [
  'SALE_INVOICE',
  'SALE_RETURN',
  'PURCHASE',
  'PURCHASE_RETURN',
  'PURCHASE_ORDER',
  'PURCHASE_REQUISITION',
  'PURCHASE_QUOTATION',
  'PURCHASE_INVOICE',
  'GRN',
  'SUPPLIER_PAYMENT',
  'TRANSFER',
  'STOCK_ADJUSTMENT',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'DELIVERY_ORDER',
  'ORDER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const STOCK_MOVEMENT_TYPES = [
  'OPENING_STOCK',
  'SALE',
  'SALE_RETURN',
  'PURCHASE_RECEIPT',
  'PURCHASE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'TRANSFER_RESERVE',
  'TRANSFER_RESERVATION_RELEASE',
  'TRANSFER_DAMAGE',
  'TRANSFER_SHORTAGE',
  'TRANSFER_EXCESS_ADJUSTMENT',
  'RETURN_TRANSFER_OUT',
  'RETURN_TRANSFER_IN',
  'ADJUSTMENT_PLUS',
  'ADJUSTMENT_MINUS',
  'DAMAGE',
  'EXPIRY',
  'DISPOSAL',
  'RECALL',
  'STOCKTAKE_CORRECTION',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'WAREHOUSE_RECEIPT',
  'WAREHOUSE_DISPATCH',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * Packaging conversion helper
 */
export function convertUnits(
  quantity: number,
  fromConversionFactor: number = 1.0,
  toConversionFactor: number = 1.0
): number {
  if (fromConversionFactor <= 0 || toConversionFactor <= 0) {
    throw new Error('Conversion factors must be greater than zero');
  }
  const baseUnits = quantity * fromConversionFactor;
  return baseUnits / toConversionFactor;
}
