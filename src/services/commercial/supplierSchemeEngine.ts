import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  SupplierScheme,
  SupplierSchemeType,
} from '../../domain/commercialTypes';

export interface ApplySupplierSchemeParams {
  organizationId: string;
  supplierId?: string | null;
  medicineId: string;
  billedQuantity: number;
  purchasePrice: number; // in Rupees
  requestedDiscountPct?: number;
  asOfDate?: Date;
}

export interface SupplierSchemeResult {
  schemeApplied?: SupplierScheme | null;
  billedQuantity: number;
  freeQuantity: number;
  totalReceivedQuantity: number;
  invoicePurchaseRate: number;
  tradeDiscountPct: number;
  flatDiscountPaise: number;
  schemeCreditPaise: number;
  totalPaidAmount: number;
  totalPaidAmountPaise: number;
  effectiveUnitCost: number;
  effectiveUnitCostPaise: number;
}

export class SupplierSchemeEngine {
  /**
   * Evaluates active supplier schemes for an inward purchase line and calculates effective acquisition cost
   */
  static evaluateInwardScheme(params: ApplySupplierSchemeParams): SupplierSchemeResult {
    const {
      organizationId,
      supplierId,
      medicineId,
      billedQuantity,
      purchasePrice,
      requestedDiscountPct = 0,
      asOfDate = new Date(),
    } = params;

    const nowIso = asOfDate.toISOString();

    // 1. Fetch active supplier scheme matching supplier and product
    let schemeRow: any = null;

    if (supplierId) {
      schemeRow = localDb
        .prepare(
          `SELECT * FROM supplier_schemes
           WHERE (organization_id = ?)
             AND (supplier_id = ? OR supplier_id = ? OR supplier_id IS NULL)
             AND (medicine_id = ? OR medicine_id = ? OR medicine_id IS NULL)
             AND status = 'ACTIVE' AND _deleted = 0
             AND (start_at IS NULL OR start_at <= ?)
             AND (end_at IS NULL OR end_at >= ?)
           ORDER BY priority DESC, created_at DESC LIMIT 1`
        )
        .get(organizationId, supplierId, supplierId, medicineId, medicineId, nowIso, nowIso);
    } else {
      schemeRow = localDb
        .prepare(
          `SELECT * FROM supplier_schemes
           WHERE (organization_id = ?)
             AND (medicine_id = ? OR medicine_id = ? OR medicine_id IS NULL)
             AND status = 'ACTIVE' AND _deleted = 0
             AND (start_at IS NULL OR start_at <= ?)
             AND (end_at IS NULL OR end_at >= ?)
           ORDER BY priority DESC, created_at DESC LIMIT 1`
        )
        .get(organizationId, medicineId, medicineId, nowIso, nowIso);
    }

    let freeQuantity = 0;
    let tradeDiscountPct = requestedDiscountPct;
    let flatDiscountPaise = 0;
    let schemeCreditPaise = 0;

    if (schemeRow) {
      const minQty = Number(schemeRow.min_quantity || 1);
      if (billedQuantity >= minQty) {
        if (schemeRow.scheme_type === 'BUY_X_GET_Y_FREE') {
          const multiples = Math.floor(billedQuantity / minQty);
          freeQuantity = multiples * Number(schemeRow.free_quantity || 0);
          if (schemeRow.discount_pct != null && Number(schemeRow.discount_pct) > 0) {
            tradeDiscountPct = Math.max(tradeDiscountPct, Number(schemeRow.discount_pct));
          }
        } else if (schemeRow.scheme_type === 'TRADE_DISCOUNT_PCT') {
          tradeDiscountPct = Math.max(tradeDiscountPct, Number(schemeRow.discount_pct || 0));
        } else if (schemeRow.scheme_type === 'FLAT_DISCOUNT') {
          flatDiscountPaise = Number(schemeRow.flat_discount_paise || 0);
        } else if (schemeRow.scheme_type === 'SCHEME_CREDIT') {
          schemeCreditPaise = Number(schemeRow.scheme_credit_paise || 0);
        }
      }
    }

    const totalReceivedQuantity = billedQuantity + freeQuantity;

    // 2. Exact Money Calculations
    const lineGross = Money.round2(billedQuantity * purchasePrice);
    const lineDiscountAmt = Money.round2((lineGross * tradeDiscountPct) / 100);
    const flatDiscountRs = Money.toRupees(flatDiscountPaise);
    const totalPaidAmount = Math.max(0, Money.round2(lineGross - lineDiscountAmt - flatDiscountRs));
    const totalPaidAmountPaise = Money.toPaise(totalPaidAmount);

    // 3. Effective Unit Cost: total paid / total received physical units
    const effectiveUnitCostPaise = totalReceivedQuantity > 0
      ? Math.round(totalPaidAmountPaise / totalReceivedQuantity)
      : Money.toPaise(purchasePrice);
    const effectiveUnitCost = Money.toRupees(effectiveUnitCostPaise);

    return {
      schemeApplied: schemeRow || null,
      billedQuantity,
      freeQuantity,
      totalReceivedQuantity,
      invoicePurchaseRate: purchasePrice,
      tradeDiscountPct,
      flatDiscountPaise,
      schemeCreditPaise,
      totalPaidAmount,
      totalPaidAmountPaise,
      effectiveUnitCost,
      effectiveUnitCostPaise,
    };
  }

  /**
   * Supplier Schemes CRUD
   */
  static listSchemes(organizationId: string): SupplierScheme[] {
    return localDb
      .prepare(
        `SELECT ss.*, sup.name as supplier_name, med.name as medicine_name
         FROM supplier_schemes ss
         LEFT JOIN suppliers sup ON sup.id = ss.supplier_id OR sup._local_id = ss.supplier_id
         LEFT JOIN medicines med ON med.id = ss.medicine_id OR med._local_id = ss.medicine_id
         WHERE (ss.organization_id = ?) AND ss._deleted = 0
         ORDER BY ss.priority DESC, ss.created_at DESC`
      )
      .all(organizationId) as SupplierScheme[];
  }

  static createScheme(data: Partial<SupplierScheme>): SupplierScheme {
    const id = data.id || uuidv4();
    const created = localMutate({
      table: 'supplier_schemes',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: data.organization_id,
        supplier_id: data.supplier_id || null,
        name: data.name,
        scheme_type: data.scheme_type || 'BUY_X_GET_Y_FREE',
        medicine_id: data.medicine_id || null,
        category_id: data.category_id || null,
        manufacturer: data.manufacturer || null,
        min_quantity: data.min_quantity ?? 1,
        free_quantity: data.free_quantity ?? 0,
        discount_pct: data.discount_pct ?? 0,
        flat_discount_paise: data.flat_discount_paise ?? 0,
        scheme_credit_paise: data.scheme_credit_paise ?? 0,
        start_at: data.start_at || null,
        end_at: data.end_at || null,
        status: data.status || 'ACTIVE',
        priority: data.priority ?? 10,
        config_json: typeof data.config_json === 'object' ? JSON.stringify(data.config_json) : (data.config_json || '{}'),
      },
    });
    return created as SupplierScheme;
  }
}
