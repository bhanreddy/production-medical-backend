import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { queryRaw, queryCount } from '../lib/postgresDb';
import { computeCogs } from '../lib/cogsQuery';

export const analyticsRouter = Router();

function startDateFromRange(range: number): string {
  const d = new Date();
  d.setDate(d.getDate() - range);
  return d.toISOString();
}

function parseRangeDays(raw: string | undefined, fallback = 30): number {
  const n = parseInt(String(raw ?? '').replace(/\D/g, '') || String(fallback), 10);
  return Math.min(Math.max(n, 1), 365);
}

function bucketKey(iso: string, period: string): string {
  const d = new Date(iso);
  if (period === 'weekly') {
    const w = new Date(d);
    w.setDate(d.getDate() - d.getDay());
    return w.toISOString().split('T')[0];
  }
  if (period === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return d.toISOString().split('T')[0];
}

analyticsRouter.get('/revenue-trend', requireAuth, async (req, res, next) => {
  try {
    const period = (req.query.period as string) || 'daily';
    const range = parseRangeDays(req.query.range as string, 30);
    const clinicId = req.user!.clinic_id!;
    const from = startDateFromRange(range);

    const sales = await queryRaw<{ created_at: string; net_amount: number }>(
      `SELECT created_at, net_amount FROM sales
       WHERE clinic_id = ? AND deleted_at IS NULL AND COALESCE(is_return, false) = false
       AND created_at >= ?`,
      [clinicId, from]
    );

    const map = new Map<string, { revenue: number; bills: number }>();
    for (const s of sales) {
      const key = bucketKey(s.created_at, period);
      const cur = map.get(key) || { revenue: 0, bills: 0 };
      cur.revenue += Number(s.net_amount);
      cur.bills += 1;
      map.set(key, cur);
    }

    const data = Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, m]) => ({
        date,
        revenue: Math.round(m.revenue * 100) / 100,
        bills: m.bills,
        avg_basket: m.bills ? Math.round((m.revenue / m.bills) * 100) / 100 : 0,
      }));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/medicine-performance', requireAuth, async (req, res, next) => {
  try {
    const from = (req.query.from as string) || startDateFromRange(30);
    const to = (req.query.to as string) || new Date().toISOString();
    const sort = (req.query.sort as string) || 'revenue';
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
    const clinicId = req.user!.clinic_id!;

    const rows = await queryRaw<{ medicine_id: string; name: string; qty: number; revenue: number }>(
      `SELECT si.medicine_id, COALESCE(m.name, si.medicine_id::text) as name,
              SUM(si.quantity)::int as qty, SUM(si.total) as revenue
       FROM sale_items si
       INNER JOIN sales s ON s.id::text = si.sale_id::text
       LEFT JOIN medicines m ON m.id::text = si.medicine_id::text
       WHERE si.deleted_at IS NULL AND s.deleted_at IS NULL
         AND COALESCE(s.is_return, false) = false
         AND s.clinic_id = ?
         AND s.created_at >= ? AND s.created_at <= ?
       GROUP BY si.medicine_id, m.name`,
      [clinicId, from, to]
    );

    let list = rows.map((r) => ({
      medicine_id: r.medicine_id,
      name: r.name,
      quantity_sold: Number(r.qty),
      revenue: Math.round(Number(r.revenue) * 100) / 100,
      margin_pct: 0,
      sell_through_rate: Number(r.qty),
    }));

    if (sort === 'qty') list.sort((a, b) => b.quantity_sold - a.quantity_sold);
    else list.sort((a, b) => b.revenue - a.revenue);

    res.json({ data: list.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/customer-insights', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;

    const customers = await queryRaw<{ id: string; name: string; importance_score: number; last_purchase_date: string }>(
      `SELECT id, name, importance_score, last_purchase_date
       FROM customers
       WHERE clinic_id = ? AND deleted_at IS NULL AND COALESCE(is_active, true) = true`,
      [clinicId]
    );

    const now = new Date();
    const seg = { high_value: 0, regular: 0, at_risk: 0, lost: 0 };
    for (const c of customers) {
      const score = Number(c.importance_score) || 0;
      if (score >= 80) seg.high_value += 1;
      if (!c.last_purchase_date) {
        seg.lost += 1;
        continue;
      }
      const days = Math.floor((now.getTime() - new Date(c.last_purchase_date).getTime()) / 86400000);
      if (days <= 30) seg.regular += 1;
      else if (days <= 60) seg.at_risk += 1;
      else seg.lost += 1;
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const newCust = await queryCount('customers', 'clinic_id = ? AND created_at >= ?', [clinicId, monthStart.toISOString()]);

    const sales = await queryRaw<{ net_amount: number; customer_id: string }>(
      `SELECT net_amount, customer_id FROM sales
       WHERE clinic_id = ? AND deleted_at IS NULL AND COALESCE(is_return, false) = false
       AND created_at >= ?`,
      [clinicId, startDateFromRange(30)]
    );

    const baskets = sales.filter((s) => s.customer_id);
    const sum = baskets.reduce((a, s) => a + Number(s.net_amount), 0);
    const avg_basket_size = baskets.length ? Math.round((sum / baskets.length) * 100) / 100 : 0;

    const topRows = await queryRaw<{ id: string; name: string; total_spent: number; order_count: number; importance_score: number }>(
      `SELECT c.id, c.name, c.importance_score,
              COALESCE(SUM(s.net_amount), 0) as total_spent,
              COUNT(s.id)::int as order_count
       FROM customers c
       LEFT JOIN sales s ON s.customer_id::text = c.id::text
         AND s.deleted_at IS NULL AND COALESCE(s.is_return, false) = false
       WHERE c.clinic_id = ? AND c.deleted_at IS NULL AND COALESCE(c.is_active, true) = true
       GROUP BY c.id, c.name, c.importance_score
       ORDER BY total_spent DESC
       LIMIT 5`,
      [clinicId]
    );

    const top = topRows.map((c) => ({
      id: c.id,
      name: c.name,
      total_purchases: Number(c.order_count) || 0,
      total_spent: Math.round(Number(c.total_spent) * 100) / 100,
      importance_score: Number(c.importance_score) || 0,
    }));

    res.json({
      data: {
        new_customers_this_month: newCust,
        returning_customers_pct: customers.length
          ? Math.round((seg.regular / Math.max(customers.length, 1)) * 10000) / 100
          : 0,
        avg_basket_size,
        top_customers: top,
        customer_segments: seg,
      },
    });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/inventory-health', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;

    const batches = await queryRaw<{ quantity_remaining: number; purchase_price: number; expiry_date: string }>(
      `SELECT quantity_remaining, purchase_price, expiry_date FROM medicine_batches
       WHERE clinic_id = ? AND deleted_at IS NULL AND quantity_remaining > 0`,
      [clinicId]
    );

    let total_inventory_value = 0;
    let expiry_risk_value = 0;
    const soon = new Date();
    soon.setDate(soon.getDate() + 90);
    for (const b of batches) {
      const v = Number(b.quantity_remaining) * Number(b.purchase_price);
      total_inventory_value += v;
      if (new Date(b.expiry_date) <= soon) expiry_risk_value += v;
    }

    const from = startDateFromRange(30);
    const cogs = await computeCogs(from, new Date().toISOString());
    const turnover_ratio = total_inventory_value > 0 ? Math.round((cogs / total_inventory_value) * 1000) / 1000 : 0;

    const saleQty = await queryRaw<{ quantity: number }>(
      `SELECT si.quantity FROM sale_items si
       INNER JOIN sales s ON s.id::text = si.sale_id::text
       WHERE si.deleted_at IS NULL AND s.deleted_at IS NULL
         AND COALESCE(s.is_return, false) = false
         AND s.clinic_id = ? AND s.created_at >= ?`,
      [clinicId, from]
    );

    const soldQty = saleQty.reduce((a, r) => a + Number(r.quantity), 0);
    const avg_daily_sales_qty = soldQty / 30;
    const totalQty = batches.reduce((a, b) => a + Number(b.quantity_remaining), 0);
    const days_of_supply = avg_daily_sales_qty > 0 ? Math.round(totalQty / avg_daily_sales_qty) : 0;

    res.json({
      data: {
        total_inventory_value: Math.round(total_inventory_value * 100) / 100,
        slow_moving_value: 0,
        expiry_risk_value: Math.round(expiry_risk_value * 100) / 100,
        turnover_ratio,
        days_of_supply,
      },
    });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/payment-behaviour', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const from = startDateFromRange(90);

    const sales = await queryRaw<{ payment_mode: string; balance_due: number; created_at: string; net_amount: number }>(
      `SELECT payment_mode, balance_due, created_at, net_amount FROM sales
       WHERE clinic_id = ? AND deleted_at IS NULL AND COALESCE(is_return, false) = false
       AND created_at >= ?`,
      [clinicId, from]
    );

    const modes: Record<string, { count: number; amount: number }> = {};
    for (const s of sales) {
      const mode = s.payment_mode || 'unknown';
      const cur = modes[mode] || { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += Number(s.net_amount);
      modes[mode] = cur;
    }

    const now = new Date();
    const aging = { d0_7: 0, d8_30: 0, d31_60: 0, d60p: 0 };
    for (const s of sales) {
      if (Number(s.balance_due) <= 0) continue;
      const days = Math.floor((now.getTime() - new Date(s.created_at).getTime()) / 86400000);
      if (days <= 7) aging.d0_7 += Number(s.balance_due);
      else if (days <= 30) aging.d8_30 += Number(s.balance_due);
      else if (days <= 60) aging.d31_60 += Number(s.balance_due);
      else aging.d60p += Number(s.balance_due);
    }

    res.json({
      data: {
        payment_mode_split: modes,
        outstanding_aging: aging,
      },
    });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/purchase-intelligence', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const from = startDateFromRange(90);

    const purchases = await queryRaw<{ net_amount: number; supplier_id: string; supplier_name: string }>(
      `SELECT p.net_amount, p.supplier_id, COALESCE(sup.name, 'Unknown') as supplier_name
       FROM purchases p
       LEFT JOIN suppliers sup ON sup.id::text = p.supplier_id::text
       WHERE p.clinic_id = ? AND p.deleted_at IS NULL AND p.created_at >= ?`,
      [clinicId, from]
    );

    const bySup: Record<string, { name: string; value: number }> = {};
    for (const p of purchases) {
      const sid = p.supplier_id || 'none';
      const cur = bySup[sid] || { name: p.supplier_name, value: 0 };
      cur.value += Number(p.net_amount);
      bySup[sid] = cur;
    }

    const top_suppliers_by_value = Object.values(bySup)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const stock = await queryRaw<{ medicine_id: string; total_stock: number }>(
      `SELECT medicine_id, SUM(quantity_remaining)::int as total_stock
       FROM medicine_batches
       WHERE clinic_id = ? AND deleted_at IS NULL AND quantity_remaining > 0
       GROUP BY medicine_id`,
      [clinicId]
    );

    const soldM = await queryRaw<{ medicine_id: string; quantity: number }>(
      `SELECT si.medicine_id, si.quantity FROM sale_items si
       INNER JOIN sales s ON s.id::text = si.sale_id::text
       WHERE si.deleted_at IS NULL AND s.deleted_at IS NULL
         AND COALESCE(s.is_return, false) = false
         AND s.clinic_id = ? AND s.created_at >= ?`,
      [clinicId, startDateFromRange(30)]
    );

    const soldMap: Record<string, number> = {};
    for (const r of soldM) {
      soldMap[r.medicine_id] = (soldMap[r.medicine_id] || 0) + Number(r.quantity);
    }

    const overstock: Array<{ medicine_id: string; stock: number; avg_monthly_sales: number }> = [];
    for (const row of stock) {
      const avg = soldMap[row.medicine_id] || 0;
      if (avg > 0 && Number(row.total_stock) > 3 * avg) {
        overstock.push({
          medicine_id: row.medicine_id,
          stock: Number(row.total_stock),
          avg_monthly_sales: avg,
        });
      }
    }

    res.json({
      data: {
        top_suppliers_by_value,
        avg_lead_time_per_supplier: [],
        purchase_vs_sales_ratio: 0,
        overstock_medicines: overstock.slice(0, 50),
      },
    });
  } catch (err) {
    next(err);
  }
});
