// inventoryClassificationEngine.ts — ABC, Movement Velocity, Days of Cover, Ageing & Dead Stock Engine
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import { ABCClass, MovementClass } from '../../domain/inventoryTypes';

export interface ClassificationMetric {
  medicineId: string;
  medicineName: string;
  category?: string;
  storeId: string | null;
  abcClass: ABCClass;
  movementClass: MovementClass;
  avgDailySales7d: number;
  avgDailySales30d: number;
  avgDailySales90d: number;
  daysOfCover: number;
  availableStock: number;
  onHandStock: number;
  totalSalesValuePaise90d: number;
  daysSinceLastSale: number;
  lastSaleDate: string | null;
}

export interface AgeingBucketSummary {
  bucket: string;
  batchCount: number;
  totalUnits: number;
  totalCostPaise: number;
  totalMrpPaise: number;
}

export class InventoryClassificationEngine {
  /**
   * Compute and cache ABC & Movement Velocity classifications for an organization/store
   */
  static computeClassifications(params: {
    organizationId: string;
    storeId?: string | null;
  }): ClassificationMetric[] {
    const { organizationId, storeId = null } = params;
    const now = new Date();
    const nowIso = now.toISOString();

    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Fetch all medicines and their sales over the last 90 days
    let salesQuery = `
      SELECT si.medicine_id,
             m.name as medicine_name,
             m.category,
             COALESCE(SUM(CASE WHEN s.sale_date >= ? THEN si.base_quantity ELSE 0 END), 0) as units_7d,
             COALESCE(SUM(CASE WHEN s.sale_date >= ? THEN si.base_quantity ELSE 0 END), 0) as units_30d,
             COALESCE(SUM(si.base_quantity), 0) as units_90d,
             COALESCE(SUM(si.taxable_amount_paise + si.tax_amount_paise), 0) as value_paise_90d,
             MAX(s.sale_date) as last_sale_date
      FROM sale_items si
      JOIN sales s ON (s.id = si.sale_id OR s._local_id = si.sale_id) AND (s.is_return = 0 OR s.is_return IS NULL)
      JOIN medicines m ON (m.id = si.medicine_id OR m._local_id = si.medicine_id)
      WHERE s.organization_id = ? AND s.sale_date >= ?
    `;
    const salesParams: any[] = [sevenDaysAgo, thirtyDaysAgo, organizationId, ninetyDaysAgo];

    if (storeId) {
      salesQuery += ` AND (s.store_id = ? OR s.store_id IS NULL)`;
      salesParams.push(storeId);
    }
    salesQuery += ` GROUP BY si.medicine_id`;

    const salesRows: any[] = localDb.prepare(salesQuery).all(...salesParams);
    const salesMap = new Map<string, any>();
    for (const r of salesRows) {
      salesMap.set(r.medicine_id, r);
    }

    // 2. Fetch all active medicines in the organization
    const allMedicines: any[] = localDb
      .prepare('SELECT id, name, category FROM medicines WHERE (_deleted = 0 OR _deleted IS NULL) AND (is_active = 1 OR is_active IS NULL)')
      .all();

    // 3. Fetch current stock availability per medicine
    let stockQuery = `
      SELECT ip.medicine_id, 
             COALESCE(SUM(ip.quantity_on_hand), 0) as total_on_hand,
             COALESCE(SUM(ip.quantity_available), 0) as total_available
      FROM inventory_positions ip
      WHERE ip.organization_id = ?
    `;
    const stockParams: any[] = [organizationId];
    if (storeId) {
      stockQuery += ` AND ip.store_id = ?`;
      stockParams.push(storeId);
    }
    stockQuery += ` GROUP BY ip.medicine_id`;

    const stockRows: any[] = localDb.prepare(stockQuery).all(...stockParams);
    const stockMap = new Map<string, { onHand: number; available: number }>();
    for (const s of stockRows) {
      stockMap.set(s.medicine_id, {
        onHand: Number(s.total_on_hand || 0),
        available: Number(s.total_available || 0),
      });
    }

    // 4. Calculate metrics per medicine
    const totalOrgSalesValue90d = salesRows.reduce(
      (sum, r) => sum + Number(r.value_paise_90d || 0),
      0
    );

    // Sort by 90d value desc for ABC calculation
    const sortedMedSales = [...salesRows].sort(
      (a, b) => Number(b.value_paise_90d || 0) - Number(a.value_paise_90d || 0)
    );

    let cumulativeValue = 0;
    const abcMap = new Map<string, ABCClass>();
    for (const item of sortedMedSales) {
      cumulativeValue += Number(item.value_paise_90d || 0);
      const pct = totalOrgSalesValue90d > 0 ? (cumulativeValue / totalOrgSalesValue90d) * 100 : 100;
      if (pct <= 70) {
        abcMap.set(item.medicine_id, 'A');
      } else if (pct <= 90) {
        abcMap.set(item.medicine_id, 'B');
      } else {
        abcMap.set(item.medicine_id, 'C');
      }
    }

    const results: ClassificationMetric[] = [];

    for (const med of allMedicines) {
      const sales = salesMap.get(med.id);
      const stock = stockMap.get(med.id) || { onHand: 0, available: 0 };

      const units7d = Number(sales?.units_7d || 0);
      const units30d = Number(sales?.units_30d || 0);
      const units90d = Number(sales?.units_90d || 0);
      const value90d = Number(sales?.value_paise_90d || 0);

      const avgDaily7d = Number((units7d / 7).toFixed(4));
      const avgDaily30d = Number((units30d / 30).toFixed(4));
      const avgDaily90d = Number((units90d / 90).toFixed(4));

      // Use 30d daily sales as primary velocity demand baseline
      const primaryDailyDemand = avgDaily30d > 0 ? avgDaily30d : avgDaily90d;
      const daysOfCover =
        primaryDailyDemand > 0
          ? Number((stock.available / primaryDailyDemand).toFixed(1))
          : stock.available > 0
          ? 999.0
          : 0.0;

      // Last sale date & days since
      const lastSaleDate = sales?.last_sale_date || null;
      let daysSinceLastSale = 999;
      if (lastSaleDate) {
        const diffMs = now.getTime() - new Date(lastSaleDate).getTime();
        daysSinceLastSale = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      }

      // Movement Classification
      let movementClass: MovementClass = 'NORMAL';
      if (stock.available > 0 && daysSinceLastSale > 180 && units90d === 0) {
        movementClass = 'DEAD_STOCK';
      } else if (stock.available > 0 && daysSinceLastSale > 90 && units90d === 0) {
        movementClass = 'NON_MOVING';
      } else if (primaryDailyDemand >= 5) {
        movementClass = 'FAST_MOVING';
      } else if (primaryDailyDemand > 0 && primaryDailyDemand < 1) {
        movementClass = 'SLOW_MOVING';
      } else if (primaryDailyDemand >= 1 && primaryDailyDemand < 5) {
        movementClass = 'NORMAL';
      } else if (stock.available === 0 && units90d === 0) {
        movementClass = 'NON_MOVING';
      }

      const abcClass = abcMap.get(med.id) || 'C';

      results.push({
        medicineId: med.id,
        medicineName: med.name,
        category: med.category,
        storeId,
        abcClass,
        movementClass,
        avgDailySales7d: avgDaily7d,
        avgDailySales30d: avgDaily30d,
        avgDailySales90d: avgDaily90d,
        daysOfCover,
        availableStock: stock.available,
        onHandStock: stock.onHand,
        totalSalesValuePaise90d: value90d,
        daysSinceLastSale,
        lastSaleDate,
      });

      // Upsert into inventory_classifications cache
      const classId = uuidv4();
      localDb
        .prepare(
          `INSERT OR REPLACE INTO inventory_classifications (
            id, _local_id, organization_id, store_id, warehouse_id,
            medicine_id, abc_class, movement_class, avg_daily_sales_7d,
            avg_daily_sales_30d, avg_daily_sales_90d, days_of_stock_cover,
            last_sale_date, days_since_last_sale, total_sales_units_90d,
            total_sales_value_paise_90d, computed_at, created_at, updated_at, _updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          classId,
          classId,
          organizationId,
          storeId,
          med.id,
          abcClass,
          movementClass,
          avgDaily7d,
          avgDaily30d,
          avgDaily90d,
          daysOfCover,
          lastSaleDate,
          daysSinceLastSale,
          units90d,
          value90d,
          nowIso,
          nowIso,
          nowIso,
          nowIso
        );
    }

    return results;
  }

  /**
   * Compute inventory ageing buckets (0-30, 31-60, 61-90, 91-180, 181-365, 365+ days)
   */
  static getAgeingAnalysis(params: {
    organizationId: string;
    storeId?: string | null;
  }): {
    buckets: AgeingBucketSummary[];
    totalStockCostPaise: number;
    totalStockMrpPaise: number;
  } {
    const { organizationId, storeId = null } = params;
    const now = new Date();

    let query = `
      SELECT mb.*, 
             COALESCE(ip.quantity_on_hand, mb.quantity_remaining, 0) as pos_on_hand
      FROM medicine_batches mb
      LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id AND ip.organization_id = ?
      WHERE (mb._deleted = 0 OR mb._deleted IS NULL) AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
        AND mb.quantity_remaining > 0
    `;
    const queryParams: any[] = [organizationId];

    if (storeId) {
      query += ` AND (mb.store_id = ? OR ip.store_id = ?)`;
      queryParams.push(storeId, storeId);
    }

    const batches: any[] = localDb.prepare(query).all(...queryParams);

    const bucketDefs = [
      { name: '0-30 days', min: 0, max: 30 },
      { name: '31-60 days', min: 31, max: 60 },
      { name: '61-90 days', min: 61, max: 90 },
      { name: '91-180 days', min: 91, max: 180 },
      { name: '181-365 days', min: 181, max: 365 },
      { name: '365+ days', min: 366, max: 99999 },
    ];

    const buckets: AgeingBucketSummary[] = bucketDefs.map((b) => ({
      bucket: b.name,
      batchCount: 0,
      totalUnits: 0,
      totalCostPaise: 0,
      totalMrpPaise: 0,
    }));

    let totalStockCostPaise = 0;
    let totalStockMrpPaise = 0;

    for (const b of batches) {
      const createdAt = new Date(b.created_at || now.toISOString());
      const ageDays = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)));
      const units = Number(b.pos_on_hand || 0);
      const unitCost = Number(b.cost_price_paise || Math.round((b.purchase_price || 0) * 100));
      const unitMrp = Number(b.mrp_paise || Math.round((b.mrp || 0) * 100));

      const batchCost = units * unitCost;
      const batchMrp = units * unitMrp;

      totalStockCostPaise += batchCost;
      totalStockMrpPaise += batchMrp;

      for (let i = 0; i < bucketDefs.length; i++) {
        if (ageDays >= bucketDefs[i].min && ageDays <= bucketDefs[i].max) {
          buckets[i].batchCount++;
          buckets[i].totalUnits += units;
          buckets[i].totalCostPaise += batchCost;
          buckets[i].totalMrpPaise += batchMrp;
          break;
        }
      }
    }

    return {
      buckets,
      totalStockCostPaise,
      totalStockMrpPaise,
    };
  }
}
