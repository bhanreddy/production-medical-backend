// internalReplenishmentEngine.ts — Central Warehouse Replenishment & Decision Optimization Engine
import { localDb } from '../../local-db';
import { ReplenishmentDecision, TransferPriority } from '../../domain/transferTypes';
import { InventoryAvailabilityService } from '../inventory/inventoryAvailabilityService';
import { StockTransferService } from './stockTransferService';

export class InternalReplenishmentEngine {
  /**
   * Evaluate replenishment demand across a destination store
   */
  static evaluateStoreReplenishment(params: {
    organizationId: string;
    destinationStoreId: string;
    lookbackDays?: number;
    leadTimeDays?: number;
    safetyStockDays?: number;
  }): ReplenishmentDecision[] {
    const {
      organizationId,
      destinationStoreId,
      lookbackDays = 30,
      leadTimeDays = 3,
      safetyStockDays = 7,
    } = params;

    const store: any = localDb
      .prepare(
        `SELECT id, _local_id, name, display_name, warehouse_served_by 
         FROM stores 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?)`
      )
      .get(destinationStoreId, destinationStoreId, organizationId);

    if (!store) throw new Error(`Store not found: ${destinationStoreId}`);

    const destinationStoreName = store.display_name || store.name;

    // Fetch all active medicines
    const medicines: any[] = localDb
      .prepare(
        `SELECT m.id, m._local_id, m.name, m.reorder_level, m.min_stock, m.max_stock
         FROM medicines m
         WHERE (m.organization_id = ?) AND m._deleted = 0`
      )
      .all(organizationId);

    // Identify primary warehouse serving this store
    let primaryWarehouseId = store.warehouse_served_by;
    if (!primaryWarehouseId) {
      const defaultWh: any = localDb
        .prepare(`SELECT id FROM warehouses WHERE (organization_id = ?) AND _deleted = 0 LIMIT 1`)
        .get(organizationId);
      primaryWarehouseId = defaultWh?.id;
    }

    const decisions: ReplenishmentDecision[] = [];

    for (const med of medicines) {
      // 1. Current available stock at destination store
      const destAvail = InventoryAvailabilityService.getAvailability({
        organizationId,
        medicineId: med.id,
        locationType: 'STORE',
        storeId: destinationStoreId,
      });

      const currentAvailable = destAvail.totalAvailable;

      // 2. Compute average daily sales velocity
      const salesRow: any = localDb
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) as total_sold
           FROM sale_items si
           JOIN sales s ON (s.id = si.sale_id OR s._local_id = si.sale_id)
           WHERE (s.store_id = ? OR s.store_id = ?)
             AND (si.medicine_id = ? OR si.medicine_id = ?)
             AND s.created_at >= datetime('now', '-${lookbackDays} days')
             AND (s.status IS NULL OR s.status = 'COMPLETED')`
        )
        .get(destinationStoreId, destinationStoreId, med.id, med.id);

      const totalSold = Number(salesRow?.total_sold || 0);
      const avgDailyDemand = Math.max(0.1, totalSold / lookbackDays);

      // Target ROP & Deficit
      const leadDemand = avgDailyDemand * leadTimeDays;
      const safetyStock = avgDailyDemand * safetyStockDays;
      const targetStock = Math.max(Number(med.reorder_level || 0), Math.ceil(leadDemand + safetyStock));
      const daysOfCover = avgDailyDemand > 0 ? Math.round(currentAvailable / avgDailyDemand) : 999;

      // 3. Existing Incoming Transfers (In-transit or requested)
      const incomingTransferRow: any = localDb
        .prepare(
          `SELECT COALESCE(SUM(sti.requested_quantity - sti.received_quantity), 0) as pending_qty
           FROM stock_transfer_items sti
           JOIN stock_transfers st ON st.id = sti.transfer_id
           WHERE (st.destination_location_id = ? OR st.destination_location_id = ?)
             AND (sti.medicine_id = ? OR sti.medicine_id = ?)
             AND st.status IN ('REQUESTED', 'APPROVED', 'READY_TO_PICK', 'PICKING', 'PICKED', 'PACKED', 'DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED')
             AND st._deleted = 0`
        )
        .get(destinationStoreId, destinationStoreId, med.id, med.id);

      const incomingTransferQty = Number(incomingTransferRow?.pending_qty || 0);

      // 4. Pending Supplier Purchase Orders
      const pendingPoRow: any = localDb
        .prepare(
          `SELECT COALESCE(SUM(poi.ordered_quantity - poi.received_quantity), 0) as pending_po_qty
           FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.po_id
           WHERE (po.store_id = ? OR po.store_id = ?)
             AND (poi.medicine_id = ? OR poi.medicine_id = ?)
             AND po.status IN ('ISSUED', 'CONFIRMED', 'PARTIALLY_RECEIVED')
             AND po._deleted = 0`
        )
        .get(destinationStoreId, destinationStoreId, med.id, med.id);

      const pendingPoQty = Number(pendingPoRow?.pending_po_qty || 0);
      const totalIncoming = incomingTransferQty + pendingPoQty;

      const deficit = Math.max(0, targetStock - (currentAvailable + totalIncoming));

      if (deficit <= 0) {
        decisions.push({
          medicineId: med.id,
          medicineName: med.name,
          destinationStoreId,
          destinationStoreName,
          currentAvailableStock: currentAvailable,
          daysOfCover,
          targetStock,
          deficitQuantity: 0,
          incomingQuantity: totalIncoming,
          netRequiredQuantity: 0,
          decisionType: totalIncoming > 0 ? 'WAIT_FOR_INCOMING' : 'NO_ACTION',
          priority: 'LOW',
          reason: totalIncoming > 0 ? `Covered by incoming pipeline (${totalIncoming} units)` : 'Stock level healthy',
        });
        continue;
      }

      // Priority determination
      let priority: TransferPriority = 'NORMAL';
      if (currentAvailable === 0) priority = 'CRITICAL';
      else if (daysOfCover < 3) priority = 'URGENT';
      else if (daysOfCover < 7) priority = 'HIGH';

      // Check central warehouse availability
      let whAvail = 0;
      let whName = 'Central Warehouse';
      if (primaryWarehouseId) {
        const whAvailRes = InventoryAvailabilityService.getAvailability({
          organizationId,
          medicineId: med.id,
          locationType: 'WAREHOUSE',
          warehouseId: primaryWarehouseId,
        });
        whAvail = whAvailRes.totalAvailable;
        const whRow: any = localDb.prepare('SELECT name FROM warehouses WHERE id = ?').get(primaryWarehouseId);
        if (whRow?.name) whName = whRow.name;
      }

      if (whAvail >= deficit) {
        decisions.push({
          medicineId: med.id,
          medicineName: med.name,
          destinationStoreId,
          destinationStoreName,
          currentAvailableStock: currentAvailable,
          daysOfCover,
          targetStock,
          deficitQuantity: deficit,
          incomingQuantity: totalIncoming,
          netRequiredQuantity: deficit,
          decisionType: 'WAREHOUSE_TRANSFER',
          suggestedSourceLocationType: 'WAREHOUSE',
          suggestedSourceLocationId: primaryWarehouseId,
          suggestedSourceLocationName: whName,
          suggestedSourceAvailableStock: whAvail,
          recommendedTransferQuantity: deficit,
          priority,
          reason: `Available in Central Warehouse (${whAvail} units)`,
        });
      } else if (whAvail > 0) {
        decisions.push({
          medicineId: med.id,
          medicineName: med.name,
          destinationStoreId,
          destinationStoreName,
          currentAvailableStock: currentAvailable,
          daysOfCover,
          targetStock,
          deficitQuantity: deficit,
          incomingQuantity: totalIncoming,
          netRequiredQuantity: deficit,
          decisionType: 'WAREHOUSE_TRANSFER',
          suggestedSourceLocationType: 'WAREHOUSE',
          suggestedSourceLocationId: primaryWarehouseId,
          suggestedSourceLocationName: whName,
          suggestedSourceAvailableStock: whAvail,
          recommendedTransferQuantity: whAvail,
          priority,
          reason: `Partial warehouse stock (${whAvail} of ${deficit} needed)`,
        });
      } else {
        // Evaluate other store excess for store rebalancing candidate
        const otherStores: any[] = localDb
          .prepare(
            `SELECT s.id, s.name, s.display_name
             FROM stores s
             WHERE (s.organization_id = ?)
               AND s.id != ? AND s._deleted = 0`
          )
          .all(organizationId, destinationStoreId);

        let bestStoreCandidate: any = null;
        let maxTransferable = 0;

        for (const os of otherStores) {
          const osAvail = InventoryAvailabilityService.getAvailability({
            organizationId,
            medicineId: med.id,
            locationType: 'STORE',
            storeId: os.id,
          });

          // Compute other store protected demand
          const osSales: any = localDb
            .prepare(
              `SELECT COALESCE(SUM(quantity), 0) as sold FROM sale_items si JOIN sales s ON s.id = si.sale_id
               WHERE s.store_id = ? AND si.medicine_id = ? AND s.created_at >= datetime('now', '-30 days')`
            )
            .get(os.id, med.id);
          const osDaily = Math.max(0.1, Number(osSales?.sold || 0) / 30);
          const osProtected = Math.ceil(osDaily * 7); // 7 days protected cover
          const transferable = Math.max(0, osAvail.totalAvailable - osProtected);

          if (transferable > maxTransferable) {
            maxTransferable = transferable;
            bestStoreCandidate = {
              storeId: os.id,
              name: os.display_name || os.name,
              available: osAvail.totalAvailable,
              transferable,
            };
          }
        }

        if (bestStoreCandidate && maxTransferable >= Math.min(deficit, 10)) {
          decisions.push({
            medicineId: med.id,
            medicineName: med.name,
            destinationStoreId,
            destinationStoreName,
            currentAvailableStock: currentAvailable,
            daysOfCover,
            targetStock,
            deficitQuantity: deficit,
            incomingQuantity: totalIncoming,
            netRequiredQuantity: deficit,
            decisionType: 'STORE_REBALANCE',
            suggestedSourceLocationType: 'STORE',
            suggestedSourceLocationId: bestStoreCandidate.storeId,
            suggestedSourceLocationName: bestStoreCandidate.name,
            suggestedSourceAvailableStock: bestStoreCandidate.available,
            recommendedTransferQuantity: Math.min(deficit, maxTransferable),
            priority,
            reason: `Excess available at ${bestStoreCandidate.name} (${maxTransferable} transferable units)`,
          });
        } else {
          decisions.push({
            medicineId: med.id,
            medicineName: med.name,
            destinationStoreId,
            destinationStoreName,
            currentAvailableStock: currentAvailable,
            daysOfCover,
            targetStock,
            deficitQuantity: deficit,
            incomingQuantity: totalIncoming,
            netRequiredQuantity: deficit,
            decisionType: 'EXTERNAL_PROCUREMENT',
            priority,
            reason: 'No internal stock available across warehouse or branch stores',
          });
        }
      }
    }

    return decisions;
  }

  /**
   * Convert recommended decisions into an automated Stock Transfer Request
   */
  static createTransferFromReplenishment(params: {
    organizationId: string;
    destinationStoreId: string;
    decisions: ReplenishmentDecision[];
    requestedBy: string;
  }): any {
    const { organizationId, destinationStoreId, decisions, requestedBy } = params;

    // Group decisions by source location
    const bySource = new Map<string, ReplenishmentDecision[]>();
    for (const d of decisions) {
      if (
        (d.decisionType === 'WAREHOUSE_TRANSFER' || d.decisionType === 'STORE_REBALANCE') &&
        d.suggestedSourceLocationId &&
        (d.recommendedTransferQuantity || 0) > 0
      ) {
        const key = `${d.suggestedSourceLocationType}:${d.suggestedSourceLocationId}`;
        const list = bySource.get(key) || [];
        list.push(d);
        bySource.set(key, list);
      }
    }

    const createdTransfers: any[] = [];
    for (const [key, items] of bySource.entries()) {
      const [srcType, srcId] = key.split(':');
      const trfType = srcType === 'WAREHOUSE' ? 'WAREHOUSE_TO_STORE' : 'STORE_TO_STORE';

      const transfer = StockTransferService.createTransfer({
        organizationId,
        transferType: trfType as any,
        sourceLocationType: srcType as any,
        sourceLocationId: srcId,
        destinationLocationType: 'STORE',
        destinationLocationId: destinationStoreId,
        priority: items.some((i) => i.priority === 'CRITICAL') ? 'CRITICAL' : 'HIGH',
        reason: srcType === 'WAREHOUSE' ? 'WAREHOUSE_REPLENISHMENT' : 'STORE_REBALANCING',
        requestedBy,
        notes: `Central Replenishment generation for ${items.length} items`,
        items: items.map((i) => ({
          medicineId: i.medicineId,
          requestedQuantity: i.recommendedTransferQuantity || 1,
        })),
      });

      createdTransfers.push(transfer);
    }

    return createdTransfers;
  }
}
