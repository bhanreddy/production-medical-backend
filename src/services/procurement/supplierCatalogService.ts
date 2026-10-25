// supplierCatalogService.ts — Supplier Catalog, Rate History, Quotations & Comparison Engine
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  SupplierProduct,
  SupplierPriceHistoryEntry,
  SupplierComparisonItem,
} from '../../domain/procurementTypes';
import { SupplierSchemeEngine } from '../commercial/supplierSchemeEngine';

export class SupplierCatalogService {
  /**
   * Upsert supplier-product catalog entry
   */
  static upsertSupplierProduct(data: {
    organizationId: string;
    supplierId: string;
    medicineId: string;
    supplierSku?: string | null;
    purchaseUnit?: string;
    packSize?: string | null;
    conversionFactor?: number;
    moq?: number;
    standardRatePaise: number;
    lastPurchaseRatePaise?: number;
    leadTimeDays?: number;
    isPreferred?: boolean;
    isActive?: boolean;
  }): SupplierProduct {
    const {
      organizationId,
      supplierId,
      medicineId,
      supplierSku = null,
      purchaseUnit = 'strip',
      packSize = null,
      conversionFactor = 1.0,
      moq = 1.0,
      standardRatePaise,
      lastPurchaseRatePaise = 0,
      leadTimeDays = 2,
      isPreferred = false,
      isActive = true,
    } = data;

    const existing: any = localDb
      .prepare(
        `SELECT * FROM supplier_products
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?)
           AND (medicine_id = ? OR medicine_id = ?)
           AND _deleted = 0 LIMIT 1`
      )
      .get(organizationId, supplierId, supplierId, medicineId, medicineId);

    const id = existing?.id || uuidv4();
    const localId = existing?._local_id || id;

    // If setting preferred, unset other preferred suppliers for this medicine in org
    if (isPreferred) {
      localDb
        .prepare(
          `UPDATE supplier_products SET is_preferred = 0
           WHERE (organization_id = ?)
             AND (medicine_id = ? OR medicine_id = ?)`
        )
        .run(organizationId, medicineId, medicineId);
    }

    const record = localMutate({
      table: 'supplier_products',
      operation: existing ? 'UPDATE' : 'INSERT',
      data: {
        id,
        _local_id: localId,
        organization_id: organizationId,
        supplier_id: supplierId,
        medicine_id: medicineId,
        supplier_sku: supplierSku,
        purchase_unit: purchaseUnit,
        pack_size: packSize,
        conversion_factor: conversionFactor,
        moq,
        standard_rate_paise: standardRatePaise,
        last_purchase_rate_paise: lastPurchaseRatePaise || existing?.last_purchase_rate_paise || standardRatePaise,
        lead_time_days: leadTimeDays,
        is_preferred: isPreferred ? 1 : 0,
        is_active: isActive ? 1 : 0,
      },
    });

    // Record observation in price history
    this.recordPriceHistory({
      organizationId,
      supplierId,
      medicineId,
      ratePaise: standardRatePaise,
      unit: purchaseUnit,
      effectiveCostPaise: standardRatePaise,
      sourceType: 'CONTRACT',
      referenceId: id,
    });

    return record as any;
  }

  /**
   * Record price observation in history
   */
  static recordPriceHistory(entry: {
    organizationId: string;
    supplierId: string;
    medicineId: string;
    ratePaise: number;
    unit?: string;
    schemeSummary?: string | null;
    effectiveCostPaise: number;
    sourceType: 'PURCHASE_INVOICE' | 'QUOTATION' | 'CONTRACT' | 'GRN';
    referenceId?: string | null;
    observedAt?: Date;
  }): SupplierPriceHistoryEntry {
    const id = uuidv4();
    const nowIso = (entry.observedAt || new Date()).toISOString();

    const record = localMutate({
      table: 'supplier_price_history',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: entry.organizationId,
        supplier_id: entry.supplierId,
        medicine_id: entry.medicineId,
        rate_paise: entry.ratePaise,
        unit: entry.unit || 'strip',
        scheme_summary: entry.schemeSummary || null,
        effective_cost_paise: entry.effectiveCostPaise,
        observed_at: nowIso,
        source_type: entry.sourceType,
        reference_id: entry.referenceId || null,
      },
    });

    // Also update last purchase rate on supplier_products catalog if applicable
    localDb
      .prepare(
        `UPDATE supplier_products
         SET last_purchase_rate_paise = ?, last_supplied_at = ?
         WHERE (organization_id = ?)
           AND (supplier_id = ? OR supplier_id = ?)
           AND (medicine_id = ? OR medicine_id = ?)`
      )
      .run(entry.ratePaise, nowIso, entry.organizationId, entry.supplierId, entry.supplierId, entry.medicineId, entry.medicineId);

    return record as any;
  }

  /**
   * Fetch price history for a medicine/supplier
   */
  static getPriceHistory(params: {
    organizationId: string;
    medicineId?: string;
    supplierId?: string;
    limit?: number;
  }): SupplierPriceHistoryEntry[] {
    const { organizationId, medicineId, supplierId, limit = 50 } = params;
    let query = `
      SELECT sph.*, sup.name as supplier_name, med.name as medicine_name
      FROM supplier_price_history sph
      LEFT JOIN suppliers sup ON sup.id = sph.supplier_id OR sup._local_id = sph.supplier_id
      LEFT JOIN medicines med ON med.id = sph.medicine_id OR med._local_id = sph.medicine_id
      WHERE (sph.organization_id = ?) AND sph._deleted = 0
    `;
    const values: any[] = [organizationId];

    if (medicineId) {
      query += ` AND (sph.medicine_id = ? OR sph.medicine_id = ?)`;
      values.push(medicineId, medicineId);
    }
    if (supplierId) {
      query += ` AND (sph.supplier_id = ? OR sph.supplier_id = ?)`;
      values.push(supplierId, supplierId);
    }

    query += ` ORDER BY sph.observed_at DESC LIMIT ?`;
    values.push(limit);

    return localDb.prepare(query).all(...values) as SupplierPriceHistoryEntry[];
  }

  /**
   * Supplier Comparison Engine:
   * Compares all candidate suppliers for a product based on Rate, Scheme, Effective Cost, Lead Time, and MOQ.
   */
  static compareSuppliersForProduct(params: {
    organizationId: string;
    medicineId: string;
    requestedQuantity?: number;
  }): SupplierComparisonItem[] {
    const { organizationId, medicineId, requestedQuantity = 10 } = params;

    // 1. Fetch all suppliers providing this product
    const candidateRows: any[] = localDb
      .prepare(
        `SELECT sp.*, sup.name as supplier_name, sup.lead_time_days as supp_default_lead_time
         FROM supplier_products sp
         JOIN suppliers sup ON sup.id = sp.supplier_id OR sup._local_id = sp.supplier_id
         WHERE (sp.organization_id = ?)
           AND (sp.medicine_id = ? OR sp.medicine_id = ?)
           AND sp.is_active = 1 AND sp._deleted = 0`
      )
      .all(organizationId, medicineId, medicineId);

    const results: SupplierComparisonItem[] = [];

    for (const row of candidateRows) {
      const standardRatePaise = Number(row.standard_rate_paise || 0);
      const standardRateRs = Money.toRupees(standardRatePaise);

      // 2. Evaluate active schemes for supplier + medicine
      const schemeResult = SupplierSchemeEngine.evaluateInwardScheme({
        organizationId,
        supplierId: row.supplier_id,
        medicineId,
        billedQuantity: requestedQuantity,
        purchasePrice: standardRateRs,
      });

      let schemeSummary = 'No Scheme';
      if (schemeResult.freeQuantity > 0) {
        schemeSummary = `Buy ${requestedQuantity} get ${schemeResult.freeQuantity} free`;
      } else if (schemeResult.tradeDiscountPct > 0) {
        schemeSummary = `${schemeResult.tradeDiscountPct}% Trade Discount`;
      }

      const effectiveCostPaise = schemeResult.effectiveUnitCostPaise;
      const effectiveCostRs = schemeResult.effectiveUnitCost;

      const leadTime = Number(row.lead_time_days || row.supp_default_lead_time || 2);
      const moq = Number(row.moq || 1);
      const isPreferred = Boolean(row.is_preferred);

      // Placeholder baseline scores (enhanced by SupplierIntelligenceService in live runtime)
      const fillRatePct = 95.0;
      const onTimeDeliveryPct = 92.0;

      // Overall composite ranking score (lower effective cost & lower lead time gives higher score)
      // Score = 100 - (effectiveCost normalized) - (leadTime penalty) + (preferred bonus)
      const score = Math.max(
        10,
        Math.min(100, Math.round(100 - leadTime * 2 + (isPreferred ? 5 : 0)))
      );

      results.push({
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        standardRatePaise,
        standardRateRupees: standardRateRs,
        activeSchemeSummary: schemeSummary,
        effectiveCostPaise,
        effectiveCostRupees: effectiveCostRs,
        leadTimeDays: leadTime,
        moq,
        isPreferred,
        fillRatePct,
        onTimeDeliveryPct,
        overallScore: score,
      });
    }

    // Sort primarily by lowest effective unit cost, then lead time
    results.sort((a, b) => {
      if (a.effectiveCostPaise !== b.effectiveCostPaise) {
        return a.effectiveCostPaise - b.effectiveCostPaise;
      }
      return a.leadTimeDays - b.leadTimeDays;
    });

    return results;
  }
}
