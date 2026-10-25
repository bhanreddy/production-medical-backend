// storeRebalancingEngine.ts — Cross-Store Stock Rebalancing & Source Protection Engine
import { localDb } from '../../local-db';
import { RebalancingRecommendation, TransferPriority } from '../../domain/transferTypes';
import { InventoryAvailabilityService } from '../inventory/inventoryAvailabilityService';

export class StoreRebalancingEngine {
  /**
   * Identify excess stock in Store A and matching deficit in Store B
   * strictly protecting Store A's own demand
   */
  static evaluateRebalancing(params: {
    organizationId: string;
    safetyStockDays?: number;
    minExcessDays?: number;
  }): RebalancingRecommendation[] {
    const { organizationId, safetyStockDays = 7, minExcessDays = 14 } = params;

    const stores: any[] = localDb
      .prepare(
        `SELECT id, _local_id, store_code, name, display_name 
         FROM stores 
         WHERE (organization_id = ?) AND status = 'active' AND _deleted = 0`
      )
      .all(organizationId);

    if (stores.length < 2) return [];

    const medicines: any[] = localDb
      .prepare(
        `SELECT id, _local_id, name, reorder_level 
         FROM medicines 
         WHERE (organization_id = ?) AND _deleted = 0`
      )
      .all(organizationId);

    const recommendations: RebalancingRecommendation[] = [];

    for (const med of medicines) {
      const storeStats: Array<{
        storeId: string;
        storeName: string;
        available: number;
        dailyDemand: number;
        daysCover: number;
        protectedStock: number;
        transferable: number;
        deficit: number;
      }> = [];

      for (const store of stores) {
        const avail = InventoryAvailabilityService.getAvailability({
          organizationId,
          medicineId: med.id,
          locationType: 'STORE',
          storeId: store.id,
        });

        // 30-day demand
        const salesRow: any = localDb
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) as sold 
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
             WHERE (s.store_id = ? OR s.store_id = ?) AND (si.medicine_id = ? OR si.medicine_id = ?)
               AND s.created_at >= datetime('now', '-30 days')`
          )
          .get(store.id, store.id, med.id, med.id);

        const sold = Number(salesRow?.sold || 0);
        const dailyDemand = Math.max(0.05, sold / 30);
        const daysCover = dailyDemand > 0 ? Math.round(avail.totalAvailable / dailyDemand) : 999;
        const protectedStock = Math.ceil(dailyDemand * safetyStockDays);
        const transferable = Math.max(0, avail.totalAvailable - protectedStock);
        const targetStock = Math.ceil(dailyDemand * 14);
        const deficit = Math.max(0, targetStock - avail.totalAvailable);

        storeStats.push({
          storeId: store.id,
          storeName: store.display_name || store.name,
          available: avail.totalAvailable,
          dailyDemand,
          daysCover,
          protectedStock,
          transferable,
          deficit,
        });
      }

      // Pair excess stores with deficit stores
      const excessStores = storeStats.filter((s) => s.daysCover >= minExcessDays && s.transferable >= 5);
      const deficitStores = storeStats.filter((s) => s.daysCover < safetyStockDays && s.deficit > 0);

      for (const excess of excessStores) {
        for (const deficit of deficitStores) {
          if (excess.storeId === deficit.storeId) continue;
          if (excess.transferable <= 0) break;

          const transferQty = Math.min(excess.transferable, deficit.deficit);
          if (transferQty >= 5) {
            let priority: TransferPriority = 'NORMAL';
            if (deficit.available === 0) priority = 'CRITICAL';
            else if (deficit.daysCover < 3) priority = 'URGENT';

            recommendations.push({
              medicineId: med.id,
              medicineName: med.name,
              sourceStoreId: excess.storeId,
              sourceStoreName: excess.storeName,
              sourceOnHand: excess.available,
              sourceAvailable: excess.available,
              sourceDailyDemand: excess.dailyDemand,
              sourceProtectedStock: excess.protectedStock,
              sourceTransferableQuantity: excess.transferable,
              destinationStoreId: deficit.storeId,
              destinationStoreName: deficit.storeName,
              destinationOnHand: deficit.available,
              destinationDailyDemand: deficit.dailyDemand,
              destinationDaysCover: deficit.daysCover,
              recommendedTransferQuantity: transferQty,
              priority,
            });

            excess.transferable -= transferQty;
            deficit.deficit -= transferQty;
          }
        }
      }
    }

    return recommendations;
  }
}
