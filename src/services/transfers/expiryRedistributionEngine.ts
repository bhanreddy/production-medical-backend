// expiryRedistributionEngine.ts — Near-Expiry Stock Redistribution & Velocity-Matching Engine
import { localDb } from '../../local-db';
import { ExpiryRedistributionPlan } from '../../domain/transferTypes';

export class ExpiryRedistributionEngine {
  /**
   * Identify near-expiry batches in slow-moving stores and recommend
   * redistribution to fast-moving stores that can consume before expiry
   */
  static evaluateExpiryRedistribution(params: {
    organizationId: string;
    nearExpiryDaysThreshold?: number;
    minDailyDemandRatio?: number;
  }): ExpiryRedistributionPlan[] {
    const {
      organizationId,
      nearExpiryDaysThreshold = 90,
      minDailyDemandRatio = 2.0,
    } = params;

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Find all unexpired batches within expiry threshold
    const batches: any[] = localDb
      .prepare(
        `SELECT mb.id as batch_id, mb._local_id, mb.batch_number, mb.expiry_date, mb.medicine_id,
                m.name as medicine_name, ip.store_id, ip.quantity_available, s.name as store_name, s.display_name
         FROM medicine_batches mb
         JOIN medicines m ON m.id = mb.medicine_id OR m._local_id = mb.medicine_id
         JOIN inventory_positions ip ON (ip.batch_id = mb.id OR ip.batch_id = mb._local_id) AND ip.location_type = 'STORE'
         JOIN stores s ON s.id = ip.store_id OR s._local_id = ip.store_id
         WHERE (mb.organization_id = ?)
           AND mb.expiry_date > ?
           AND ip.quantity_available > 0
           AND mb._deleted = 0`
      )
      .all(organizationId, todayStr);

    const plans: ExpiryRedistributionPlan[] = [];

    for (const batch of batches) {
      const expDate = new Date(batch.expiry_date);
      const daysUntilExpiry = Math.ceil((expDate.getTime() - today.getTime()) / 86400000);

      if (daysUntilExpiry > nearExpiryDaysThreshold) continue;

      const sourceQty = Number(batch.quantity_available);

      // Compute source store 30-day daily demand
      const srcSalesRow: any = localDb
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) as sold 
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE (s.store_id = ? OR s.store_id = ?) AND (si.medicine_id = ? OR si.medicine_id = ?)
             AND s.created_at >= datetime('now', '-30 days')`
        )
        .get(batch.store_id, batch.store_id, batch.medicine_id, batch.medicine_id);

      const srcSold = Number(srcSalesRow?.sold || 0);
      const srcDailyDemand = Math.max(0.01, srcSold / 30);
      const srcProjectedConsumption = Math.floor(srcDailyDemand * daysUntilExpiry);
      const atRiskQty = Math.max(0, sourceQty - srcProjectedConsumption);

      if (atRiskQty <= 0) continue; // Source store will naturally sell through

      // Discover other stores with high sales velocity for this SKU
      const candidateStores: any[] = localDb
        .prepare(
          `SELECT s.id, s.name, s.display_name
           FROM stores s
           WHERE (s.organization_id = ?)
             AND s.id != ? AND s._deleted = 0`
        )
        .all(organizationId, batch.store_id);

      let bestDest: any = null;
      let maxDestCapacity = 0;

      for (const cs of candidateStores) {
        const destSalesRow: any = localDb
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) as sold 
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
             WHERE (s.store_id = ? OR s.store_id = ?) AND (si.medicine_id = ? OR si.medicine_id = ?)
               AND s.created_at >= datetime('now', '-30 days')`
          )
          .get(cs.id, cs.id, batch.medicine_id, batch.medicine_id);

        const destSold = Number(destSalesRow?.sold || 0);
        const destDailyDemand = destSold / 30;

        // Destination must sell faster than source
        if (destDailyDemand >= srcDailyDemand * minDailyDemandRatio && destDailyDemand >= 1.0) {
          const destCapacity = Math.floor(destDailyDemand * daysUntilExpiry);
          if (destCapacity > maxDestCapacity) {
            maxDestCapacity = destCapacity;
            bestDest = {
              storeId: cs.id,
              storeName: cs.display_name || cs.name,
              dailyDemand: destDailyDemand,
              capacity: destCapacity,
            };
          }
        }
      }

      if (bestDest && maxDestCapacity >= 5) {
        const recommendedQty = Math.min(atRiskQty, maxDestCapacity);
        plans.push({
          medicineId: batch.medicine_id,
          medicineName: batch.medicine_name,
          batchId: batch.batch_id,
          batchNumber: batch.batch_number,
          expiryDate: batch.expiry_date,
          daysUntilExpiry,
          sourceStoreId: batch.store_id,
          sourceStoreName: batch.display_name || batch.store_name,
          sourceQuantity: sourceQty,
          sourceDailyDemand: srcDailyDemand,
          sourceProjectedConsumption: srcProjectedConsumption,
          sourceAtRiskQuantity: atRiskQty,
          destinationStoreId: bestDest.storeId,
          destinationStoreName: bestDest.storeName,
          destinationDailyDemand: bestDest.dailyDemand,
          destinationCapacityBeforeExpiry: bestDest.capacity,
          recommendedTransferQuantity: recommendedQty,
          isFeasible: true,
          reason: `Destination velocity (${bestDest.dailyDemand.toFixed(1)}/day) can consume ${recommendedQty} units before expiry in ${daysUntilExpiry} days`,
        });
      } else {
        plans.push({
          medicineId: batch.medicine_id,
          medicineName: batch.medicine_name,
          batchId: batch.batch_id,
          batchNumber: batch.batch_number,
          expiryDate: batch.expiry_date,
          daysUntilExpiry,
          sourceStoreId: batch.store_id,
          sourceStoreName: batch.display_name || batch.store_name,
          sourceQuantity: sourceQty,
          sourceDailyDemand: srcDailyDemand,
          sourceProjectedConsumption: srcProjectedConsumption,
          sourceAtRiskQuantity: atRiskQty,
          destinationStoreId: '',
          destinationStoreName: 'None Eligible',
          destinationDailyDemand: 0,
          destinationCapacityBeforeExpiry: 0,
          recommendedTransferQuantity: 0,
          isFeasible: false,
          reason: 'No branch store possesses sufficient sales velocity to absorb near-expiry units; supplier return or markdown recommended',
        });
      }
    }

    return plans;
  }
}
