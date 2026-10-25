// expiryIntelligenceEngine.ts — Expiry Intelligence, Exposure Valuation & Action Recommendations
import { localDb } from '../../local-db';
import { ExpiryActionRecommendation } from '../../domain/inventoryTypes';
import { InventoryClassificationEngine } from './inventoryClassificationEngine';

export interface ExpiryRiskItem {
  medicineId: string;
  medicineName: string;
  category?: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  daysUntilExpiry: number;
  quantityRemaining: number;
  unitCostPaise: number;
  mrpPaise: number;
  totalCostExposurePaise: number;
  totalMrpExposurePaise: number;
  avgDailyDemand: number;
  projectedSellThroughUnits: number;
  riskQuantityUnits: number;
  riskValuePaise: number;
  recommendedAction: ExpiryActionRecommendation;
  alternativeStoreCandidate?: {
    storeId: string;
    storeName: string;
    avgDailyDemand: number;
  } | null;
}

export interface ExpiryBucketSummary {
  bucket: string;
  batchCount: number;
  totalUnits: number;
  totalCostExposurePaise: number;
  totalMrpExposurePaise: number;
}

export class ExpiryIntelligenceEngine {
  /**
   * Get detailed expiry risk items and action recommendations
   */
  static getExpiryRiskItems(params: {
    organizationId: string;
    storeId?: string | null;
    daysThreshold?: number;
  }): {
    summary: {
      totalExpiringBatches: number;
      totalCostExposurePaise: number;
      totalMrpExposurePaise: number;
      totalRiskUnits: number;
      totalRiskValuePaise: number;
    };
    buckets: ExpiryBucketSummary[];
    items: ExpiryRiskItem[];
  } {
    const { organizationId, storeId = null, daysThreshold = 180 } = params;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const maxDate = new Date(now.getTime() + daysThreshold * 24 * 60 * 60 * 1000);
    const maxDateStr = maxDate.toISOString().split('T')[0];

    let query = `
      SELECT mb.*, m.name as medicine_name, m.category,
             COALESCE(ip.quantity_on_hand, mb.quantity_remaining, 0) as pos_on_hand
      FROM medicine_batches mb
      JOIN medicines m ON m.id = mb.medicine_id
      LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id AND ip.organization_id = ?
      WHERE (mb._deleted = 0 OR mb._deleted IS NULL) AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
        AND mb.expiry_date <= ? AND mb.quantity_remaining > 0
    `;
    const queryParams: any[] = [organizationId, maxDateStr];

    if (storeId) {
      query += ` AND (mb.store_id = ? OR ip.store_id = ?)`;
      queryParams.push(storeId, storeId);
    }

    query += ` ORDER BY mb.expiry_date ASC`;

    const batches: any[] = localDb.prepare(query).all(...queryParams);

    // Fetch classifications for demand rates
    const classifications = InventoryClassificationEngine.computeClassifications({
      organizationId,
      storeId,
    });
    const demandMap = new Map<string, number>();
    for (const c of classifications) {
      demandMap.set(c.medicineId, c.avgDailySales30d || c.avgDailySales90d || 0);
    }

    const bucketDefs = [
      { name: 'EXPIRED', maxDays: 0 },
      { name: '0-30 days', maxDays: 30 },
      { name: '31-60 days', maxDays: 60 },
      { name: '61-90 days', maxDays: 90 },
      { name: '91-180 days', maxDays: 180 },
      { name: '181-365 days', maxDays: 365 },
    ];

    const buckets: ExpiryBucketSummary[] = bucketDefs.map((b) => ({
      bucket: b.name,
      batchCount: 0,
      totalUnits: 0,
      totalCostExposurePaise: 0,
      totalMrpExposurePaise: 0,
    }));

    let totalCostExposurePaise = 0;
    let totalMrpExposurePaise = 0;
    let totalRiskUnits = 0;
    let totalRiskValuePaise = 0;

    const items: ExpiryRiskItem[] = [];

    for (const b of batches) {
      const expiryDate = String(b.expiry_date || '');
      const expiryTime = new Date(expiryDate).getTime();
      const diffMs = expiryTime - now.getTime();
      const daysUntilExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      const qty = Number(b.pos_on_hand || 0);
      const unitCost = Number(b.cost_price_paise || Math.round((b.purchase_price || 0) * 100));
      const unitMrp = Number(b.mrp_paise || Math.round((b.mrp || 0) * 100));

      const batchCostExposure = qty * unitCost;
      const batchMrpExposure = qty * unitMrp;

      totalCostExposurePaise += batchCostExposure;
      totalMrpExposurePaise += batchMrpExposure;

      // Classify into bucket
      for (let i = 0; i < bucketDefs.length; i++) {
        const bDef = bucketDefs[i];
        if (
          (bDef.name === 'EXPIRED' && daysUntilExpiry <= 0) ||
          (bDef.name === '0-30 days' && daysUntilExpiry > 0 && daysUntilExpiry <= 30) ||
          (bDef.name === '31-60 days' && daysUntilExpiry > 30 && daysUntilExpiry <= 60) ||
          (bDef.name === '61-90 days' && daysUntilExpiry > 60 && daysUntilExpiry <= 90) ||
          (bDef.name === '91-180 days' && daysUntilExpiry > 90 && daysUntilExpiry <= 180) ||
          (bDef.name === '181-365 days' && daysUntilExpiry > 180 && daysUntilExpiry <= 365)
        ) {
          buckets[i].batchCount++;
          buckets[i].totalUnits += qty;
          buckets[i].totalCostExposurePaise += batchCostExposure;
          buckets[i].totalMrpExposurePaise += batchMrpExposure;
          break;
        }
      }

      const dailyDemand = demandMap.get(b.medicine_id) || 0;
      const projectedSellThrough =
        daysUntilExpiry > 0 ? Number((daysUntilExpiry * dailyDemand).toFixed(1)) : 0;
      const riskUnits = Math.max(0, qty - projectedSellThrough);
      const riskValuePaise = Math.round(riskUnits * unitCost);

      totalRiskUnits += riskUnits;
      totalRiskValuePaise += riskValuePaise;

      // Recommended Action logic
      let recommendedAction: ExpiryActionRecommendation = 'SELL_THROUGH';
      if (daysUntilExpiry <= 0) {
        recommendedAction = 'DISPOSE';
      } else if (riskUnits > 0 && daysUntilExpiry <= 30) {
        recommendedAction = 'PROMOTION_CANDIDATE';
      } else if (riskUnits > 0 && daysUntilExpiry <= 90) {
        recommendedAction = 'RETURN_TO_SUPPLIER';
      } else if (riskUnits > 0) {
        recommendedAction = 'TRANSFER_CANDIDATE';
      } else {
        recommendedAction = 'SELL_THROUGH';
      }

      items.push({
        medicineId: b.medicine_id,
        medicineName: b.medicine_name,
        category: b.category,
        batchId: b.id,
        batchNumber: b.batch_number,
        expiryDate,
        daysUntilExpiry,
        quantityRemaining: qty,
        unitCostPaise: unitCost,
        mrpPaise: unitMrp,
        totalCostExposurePaise: batchCostExposure,
        totalMrpExposurePaise: batchMrpExposure,
        avgDailyDemand: dailyDemand,
        projectedSellThroughUnits: projectedSellThrough,
        riskQuantityUnits: riskUnits,
        riskValuePaise,
        recommendedAction,
        alternativeStoreCandidate: null,
      });
    }

    return {
      summary: {
        totalExpiringBatches: items.length,
        totalCostExposurePaise,
        totalMrpExposurePaise,
        totalRiskUnits,
        totalRiskValuePaise,
      },
      buckets,
      items,
    };
  }
}
