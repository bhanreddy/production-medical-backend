// reorderEngine.ts — Demand-Driven Reorder, Pack Rounding & Replenishment Engine
import { localDb } from '../../local-db';
import {
  ReorderRecommendationResult,
  ReplenishmentType,
} from '../../domain/inventoryTypes';
import { InventoryClassificationEngine } from './inventoryClassificationEngine';
import { InventoryAvailabilityService } from './inventoryAvailabilityService';

export class ReorderEngine {
  /**
   * Calculate reorder recommendations for an organization and store
   */
  static getReorderRecommendations(params: {
    organizationId: string;
    storeId?: string | null;
    defaultLeadTimeDays?: number;
    defaultSafetyStockDays?: number;
  }): ReorderRecommendationResult[] {
    const {
      organizationId,
      storeId = null,
      defaultLeadTimeDays = 5,
      defaultSafetyStockDays = 7,
    } = params;

    // 1. Get current classifications (sales velocity, days cover)
    const classifications = InventoryClassificationEngine.computeClassifications({
      organizationId,
      storeId,
    });

    // 2. Fetch pending purchase orders for items
    let pendingPoQuery = `
      SELECT pi.medicine_id, COALESCE(SUM(pi.quantity), 0) as incoming_qty
      FROM purchase_items pi
      JOIN purchases p ON (p.id = pi.purchase_id OR p._local_id = pi.purchase_id)
      WHERE p.organization_id = ? AND (p._deleted = 0 OR p._deleted IS NULL) AND p.payment_status = 'pending'
    `;
    const poParams: any[] = [organizationId];
    if (storeId) {
      pendingPoQuery += ` AND (p.store_id = ? OR pi.store_id = ?)`;
      poParams.push(storeId, storeId);
    }
    pendingPoQuery += ` GROUP BY pi.medicine_id`;

    const poRows: any[] = localDb.prepare(pendingPoQuery).all(...poParams);
    const poMap = new Map<string, number>();
    for (const r of poRows) {
      poMap.set(r.medicine_id, Number(r.incoming_qty || 0));
    }

    // 3. Fetch warehouse stock availability for organization
    const warehouses: any[] = localDb
      .prepare('SELECT id FROM warehouses WHERE organization_id = ?')
      .all(organizationId);

    const warehouseStockMap = new Map<string, number>();
    for (const w of warehouses) {
      const whAvail: any[] = localDb
        .prepare(
          `SELECT medicine_id, SUM(quantity_available) as wh_avail 
           FROM inventory_positions 
           WHERE organization_id = ? AND warehouse_id = ?
           GROUP BY medicine_id`
        )
        .all(organizationId, w.id);

      for (const wa of whAvail) {
        const cur = warehouseStockMap.get(wa.medicine_id) || 0;
        warehouseStockMap.set(wa.medicine_id, cur + Number(wa.wh_avail || 0));
      }
    }

    // 4. Fetch medicine master configurations (pack_size, MOQ, reorder_level)
    const medConfigs: any[] = localDb
      .prepare(
        `SELECT id, name, minimum_order_quantity, reorder_level, reorder_quantity,
                units_per_pack, conversion_factor
          FROM medicines 
          WHERE (_deleted = 0 OR _deleted IS NULL) AND (is_active = 1 OR is_active IS NULL)`
      )
      .all();
    const configMap = new Map<string, any>();
    for (const m of medConfigs) {
      configMap.set(m.id, m);
    }

    const recommendations: ReorderRecommendationResult[] = [];

    for (const item of classifications) {
      const config = configMap.get(item.medicineId);
      const avgDailyDemand = item.avgDailySales30d > 0 ? item.avgDailySales30d : item.avgDailySales90d;

      const leadTimeDays = defaultLeadTimeDays;
      const safetyStockUnits =
        config?.reorder_level && config.reorder_level > 0
          ? Number(config.reorder_level)
          : Math.ceil(avgDailyDemand * defaultSafetyStockDays);

      const leadTimeDemand = avgDailyDemand * leadTimeDays;
      const reorderPoint = Math.ceil(leadTimeDemand + safetyStockUnits);

      const available = item.availableStock;
      const reserved = item.onHandStock - item.availableStock;
      const incomingPo = poMap.get(item.medicineId) || 0;

      const effectivePosition = available + incomingPo;
      const deficit = reorderPoint - effectivePosition;

      // If deficit > 0 or available < safetyStock, recommend reorder
      if (deficit > 0 || (available <= 0 && avgDailyDemand > 0)) {
        const rawDeficit = Math.max(deficit, avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * 14) : 10);
        const packSize = Number(config?.units_per_pack || config?.conversion_factor || 1) || 1;
        const moq = Number(config?.minimum_order_quantity || 1) || 1;

        // Round up to nearest pack size multiple and at least MOQ
        let recommendedQty = Math.ceil(rawDeficit / packSize) * packSize;
        if (recommendedQty < moq) {
          recommendedQty = Math.ceil(moq / packSize) * packSize;
        }

        const warehouseAvail = warehouseStockMap.get(item.medicineId) || 0;

        let recommendedType: ReplenishmentType = 'SUPPLIER_PURCHASE';
        let reason = `Stock below reorder point (${reorderPoint} units). Current available: ${available}, Incoming PO: ${incomingPo}.`;

        if (warehouseAvail >= recommendedQty) {
          recommendedType = 'WAREHOUSE_REPLENISHMENT_CANDIDATE';
          reason = `Central warehouse has ${warehouseAvail} units available. Transfer recommended before supplier purchase.`;
        }

        const confidenceScore = avgDailyDemand > 0 ? 0.95 : 0.6;

        recommendations.push({
          medicineId: item.medicineId,
          medicineName: item.medicineName,
          organizationId,
          storeId,
          availableStock: available,
          reservedStock: reserved,
          incomingPoStock: incomingPo,
          avgDailyDemand,
          leadTimeDays,
          safetyStockUnits,
          daysOfCover: item.daysOfCover,
          reorderPoint,
          calculatedDeficit: rawDeficit,
          recommendedQuantity: recommendedQty,
          recommendedType,
          packSize,
          minimumOrderQuantity: moq,
          reason,
          confidenceScore,
          warehouseAvailableUnits: warehouseAvail,
        });
      }
    }

    return recommendations;
  }
}
