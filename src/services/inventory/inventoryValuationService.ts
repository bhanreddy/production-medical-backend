// inventoryValuationService.ts — Valuation, Shrinkage & Inventory Health Score
import { localDb } from '../../local-db';
import { InventoryClassificationEngine } from './inventoryClassificationEngine';
import { ExpiryIntelligenceEngine } from './expiryIntelligenceEngine';
import { InventoryReconciliationServiceV2 } from './inventoryReconciliationV2';

export interface ValuationSummary {
  totalSkus: number;
  totalUnitsOnHand: number;
  totalUnitsAvailable: number;
  totalCostValuePaise: number;
  totalEffectiveCostPaise: number;
  totalMrpValuePaise: number;
  potentialGrossMarginPaise: number;
  potentialGrossMarginPct: number;
  healthScore: {
    score: number; // 0 to 100
    rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL';
    breakdown: {
      baseScore: number;
      stockoutDeduction: number;
      expiryDeduction: number;
      deadStockDeduction: number;
      reconciliationDeduction: number;
    };
  };
}

export class InventoryValuationService {
  /**
   * Compute comprehensive inventory valuation and health score
   */
  static getValuation(params: {
    organizationId: string;
    storeId?: string | null;
    warehouseId?: string | null;
  }): ValuationSummary {
    const { organizationId, storeId = null, warehouseId = null } = params;

    const locationCol = storeId ? 'store_id' : 'warehouse_id';
    const targetId = storeId || warehouseId;

    let query = `
      SELECT mb.*, 
             COALESCE(ip.quantity_on_hand, mb.quantity_remaining, 0) as pos_on_hand,
             COALESCE(ip.quantity_available, mb.quantity_remaining, 0) as pos_available
      FROM medicine_batches mb
      LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id AND ip.organization_id = ?
      WHERE (mb._deleted = 0 OR mb._deleted IS NULL) AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
        AND mb.quantity_remaining > 0
    `;
    const queryParams: any[] = [organizationId];

    if (targetId) {
      query += ` AND (mb.${locationCol} = ? OR ip.${locationCol} = ?)`;
      queryParams.push(targetId, targetId);
    }

    const batches: any[] = localDb.prepare(query).all(...queryParams);

    let totalUnitsOnHand = 0;
    let totalUnitsAvailable = 0;
    let totalCostValuePaise = 0;
    let totalMrpValuePaise = 0;
    const skuSet = new Set<string>();

    for (const b of batches) {
      skuSet.add(b.medicine_id);
      const onHand = Number(b.pos_on_hand || 0);
      const available = Number(b.pos_available || 0);
      const unitCost = Number(b.cost_price_paise || Math.round((b.purchase_price || 0) * 100));
      const unitMrp = Number(b.mrp_paise || Math.round((b.mrp || 0) * 100));

      totalUnitsOnHand += onHand;
      totalUnitsAvailable += available;
      totalCostValuePaise += onHand * unitCost;
      totalMrpValuePaise += onHand * unitMrp;
    }

    const potentialGrossMarginPaise = Math.max(0, totalMrpValuePaise - totalCostValuePaise);
    const potentialGrossMarginPct =
      totalMrpValuePaise > 0
        ? Number(((potentialGrossMarginPaise / totalMrpValuePaise) * 100).toFixed(2))
        : 0;

    // Compute Health Score factors
    const classifications = InventoryClassificationEngine.computeClassifications({
      organizationId,
      storeId,
    });

    const totalMedicines = classifications.length || 1;
    const outOfStockCount = classifications.filter((c) => c.availableStock === 0).length;
    const stockoutPct = (outOfStockCount / totalMedicines) * 100;
    const stockoutDeduction = Math.min(25, Number((stockoutPct * 0.8).toFixed(1)));

    const deadStockValuePaise = classifications
      .filter((c) => c.movementClass === 'DEAD_STOCK')
      .reduce((sum, c) => sum + c.totalSalesValuePaise90d, 0);

    const deadStockDeduction =
      totalCostValuePaise > 0
        ? Math.min(25, Number(((deadStockValuePaise / totalCostValuePaise) * 50).toFixed(1)))
        : 0;

    const expiryRisk = ExpiryIntelligenceEngine.getExpiryRiskItems({
      organizationId,
      storeId,
      daysThreshold: 90,
    });
    const expiryRiskValue = expiryRisk.summary.totalRiskValuePaise;
    const expiryDeduction =
      totalCostValuePaise > 0
        ? Math.min(25, Number(((expiryRiskValue / totalCostValuePaise) * 100).toFixed(1)))
        : 0;

    const recon = InventoryReconciliationServiceV2.reconcile({
      organizationId,
      storeId,
      warehouseId,
    });
    const reconciliationDeduction = Math.min(25, recon.summary.mismatchCount * 5);

    const totalDeductions =
      stockoutDeduction + deadStockDeduction + expiryDeduction + reconciliationDeduction;
    const rawScore = Math.max(0, Math.min(100, Math.round(100 - totalDeductions)));

    let rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL' = 'EXCELLENT';
    if (rawScore >= 90) rating = 'EXCELLENT';
    else if (rawScore >= 75) rating = 'GOOD';
    else if (rawScore >= 60) rating = 'FAIR';
    else if (rawScore >= 40) rating = 'POOR';
    else rating = 'CRITICAL';

    return {
      totalSkus: skuSet.size,
      totalUnitsOnHand,
      totalUnitsAvailable,
      totalCostValuePaise,
      totalEffectiveCostPaise: totalCostValuePaise,
      totalMrpValuePaise,
      potentialGrossMarginPaise,
      potentialGrossMarginPct,
      healthScore: {
        score: rawScore,
        rating,
        breakdown: {
          baseScore: 100,
          stockoutDeduction,
          expiryDeduction,
          deadStockDeduction,
          reconciliationDeduction,
        },
      },
    };
  }
}
