import { queryRaw } from '../lib/postgresDb';
import { supabaseAdmin } from '../config/supabase';
import { Money } from '../lib/money';

export interface DailySalesSummaryRow {
  clinic_id: string;
  sale_day: string;
  bill_count: number;
  revenue: number;
  gst_total: number;
  avg_basket: number;
  unique_customers: number;
}

/**
 * Enterprise Pharmacy POS — Daily Sales Summary Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Refreshes the materialized view `daily_sales_summary` and provides fast,
 * indexed retrieval of pre-aggregated revenue metrics with safe real-time fallback.
 */
export const DailySalesSummaryService = {
  /**
   * Triggers background refresh of daily_sales_summary materialized view in PostgreSQL.
   */
  async refresh(): Promise<boolean> {
    try {
      await queryRaw('SELECT refresh_daily_sales_summary()');
      return true;
    } catch (err) {
      try {
        await queryRaw('REFRESH MATERIALIZED VIEW daily_sales_summary');
        return true;
      } catch (innerErr) {
        console.warn('daily_sales_summary refresh fallback:', innerErr);
        return false;
      }
    }
  },

  /**
   * Query daily sales metrics for a clinic over a date range.
   * Tries the materialized view first; if empty or unpopulated, computes live from `sales`.
   */
  async getSummary(clinicId: string, fromDate?: string, toDate?: string): Promise<DailySalesSummaryRow[]> {
    try {
      const conditions = ['clinic_id = ?'];
      const params: any[] = [clinicId];

      if (fromDate) {
        conditions.push('sale_day >= ?::date');
        params.push(fromDate);
      }
      if (toDate) {
        conditions.push('sale_day <= ?::date');
        params.push(toDate);
      }

      const rows = await queryRaw<any>(
        `SELECT clinic_id, sale_day::text as sale_day, bill_count::int, revenue::numeric as revenue,
                gst_total::numeric as gst_total, avg_basket::numeric as avg_basket, unique_customers::int
         FROM daily_sales_summary
         WHERE ${conditions.join(' AND ')}
         ORDER BY sale_day ASC`,
        params
      );

      if (rows && rows.length > 0) {
        return rows.map(r => ({
          clinic_id: r.clinic_id,
          sale_day: r.sale_day,
          bill_count: Number(r.bill_count || 0),
          revenue: Money.round2(r.revenue || 0),
          gst_total: Money.round2(r.gst_total || 0),
          avg_basket: Money.round2(r.avg_basket || 0),
          unique_customers: Number(r.unique_customers || 0),
        }));
      }
    } catch (err) {
      // Fall through to direct query fallback
    }

    // Direct aggregation fallback from sales table
    const liveConditions = ['clinic_id = ?', '_deleted = 0', 'is_return = false'];
    const liveParams: any[] = [clinicId];

    if (fromDate) {
      liveConditions.push('created_at >= ?');
      liveParams.push(fromDate);
    }
    if (toDate) {
      liveConditions.push('created_at <= ?');
      liveParams.push(toDate);
    }

    const liveRows = await queryRaw<any>(
      `SELECT clinic_id,
              (created_at::date)::text AS sale_day,
              COUNT(*)::int AS bill_count,
              COALESCE(SUM(net_amount), 0)::numeric AS revenue,
              COALESCE(SUM(gst_amount), 0)::numeric AS gst_total,
              COALESCE(AVG(net_amount), 0)::numeric AS avg_basket,
              COUNT(DISTINCT customer_id)::int AS unique_customers
       FROM sales
       WHERE ${liveConditions.join(' AND ')}
       GROUP BY clinic_id, (created_at::date)
       ORDER BY sale_day ASC`,
      liveParams
    );

    return (liveRows || []).map(r => ({
      clinic_id: r.clinic_id,
      sale_day: r.sale_day,
      bill_count: Number(r.bill_count || 0),
      revenue: Money.round2(r.revenue || 0),
      gst_total: Money.round2(r.gst_total || 0),
      avg_basket: Money.round2(r.avg_basket || 0),
      unique_customers: Number(r.unique_customers || 0),
    }));
  }
};
