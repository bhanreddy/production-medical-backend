import {
  localMutate,
  queryAll,
  queryOne,
  queryRaw,
  queryCount,
} from "../lib/postgresDb";
import { Router } from "express";
import { Money } from "../lib/money";
import { requireAuth } from "../middleware/auth";

import { buildGstr1Payload, SaleRowForGstr1 } from "../services/gstr1Builder";
import { computeCogs } from "../lib/cogsQuery";
import {
  buildAccountingSummary,
  toAccountingSummaryPayload,
} from "../lib/accountingSummary";

export const reportsRouter = Router();

// GET /api/reports/dashboard
reportsRouter.get("/dashboard", requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const in30 = new Date();
    in30.setDate(in30.getDate() + 30);
    const in30Date = in30.toISOString().split("T")[0];

    // One round trip. Each extra query was costing a full network trip to the database.
    const [snapshot] = await queryRaw<{
      low_stock_count: number;
      expiry_count_30d: number;
      outstanding_receivable: string | number;
      outstanding_payable: string | number;
      shortbook_count: number;
      today: string;
      recent_sales: any[];
      daily: Array<{ date: string; revenue: string | number; bills: number }>;
    }>(
      `WITH tz AS (
         SELECT CASE
           WHEN c.timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = c.timezone)
           THEN c.timezone ELSE 'Asia/Kolkata'
         END AS tz
         FROM (SELECT 1) seed
         LEFT JOIN clinics c ON c.id = ?
       ),
       win AS (
         SELECT tz, (CURRENT_TIMESTAMP AT TIME ZONE tz)::date AS today FROM tz
       ),
       days AS (
         SELECT generate_series((SELECT today - 6 FROM win), (SELECT today FROM win), '1 day')::date AS day
       ),
       counted AS (
         SELECT day,
           COALESCE(SUM(CASE WHEN s.is_return THEN -s.net_amount ELSE s.net_amount END), 0) AS revenue,
           COUNT(s.id) FILTER (WHERE NOT COALESCE(s.is_return, false))::int AS bills
         FROM days
         LEFT JOIN sales s ON s.clinic_id = ?
           AND s.deleted_at IS NULL
           AND s.created_at >= ((SELECT today - 6 FROM win)::timestamp AT TIME ZONE (SELECT tz FROM win))
           AND (s.created_at AT TIME ZONE (SELECT tz FROM win))::date = days.day
         GROUP BY day
       )
       SELECT
         (SELECT today::text FROM win) AS today,
         (SELECT COUNT(*)::int FROM medicines m
          CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(mb.quantity_remaining), 0) AS stock
            FROM medicine_batches mb
            WHERE mb.clinic_id = ? AND mb.medicine_id = m.id
              AND mb.expiry_date >= (SELECT today FROM win) AND mb.deleted_at IS NULL
              AND COALESCE(mb.is_disposed, false) = false
          ) batch_stock
          WHERE m.clinic_id = ? AND m.deleted_at IS NULL AND m.is_active = true
            AND batch_stock.stock <= m.low_stock_threshold
         ) AS low_stock_count,
         (SELECT COUNT(*)::int FROM medicine_batches
          WHERE clinic_id = ? AND deleted_at IS NULL AND quantity_remaining > 0 AND expiry_date <= ?
            AND COALESCE(is_disposed, false) = false
         ) AS expiry_count_30d,
         (SELECT COALESCE(SUM(outstanding_balance), 0) FROM customers
          WHERE clinic_id = ? AND deleted_at IS NULL) AS outstanding_receivable,
         (SELECT COALESCE(SUM(outstanding_balance), 0) FROM suppliers
          WHERE clinic_id = ? AND deleted_at IS NULL) AS outstanding_payable,
         (SELECT COUNT(*)::int FROM shortbook
          WHERE clinic_id = ? AND is_ordered = false AND deleted_at IS NULL) AS shortbook_count,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', recent.id, 'invoice_number', recent.invoice_number,
            'net_amount', recent.net_amount, 'created_at', recent.created_at,
            'payment_mode', recent.payment_mode, 'is_return', recent.is_return,
            'customer_name', recent.customer_name
          ) ORDER BY recent.created_at DESC), '[]'::jsonb)
          FROM (
            SELECT s.id, s.invoice_number, s.net_amount, s.created_at, s.payment_mode,
                   COALESCE(s.is_return, false) AS is_return, c.name AS customer_name
            FROM sales s
            LEFT JOIN customers c ON c.id::text = s.customer_id::text
            WHERE s.clinic_id = ? AND s.deleted_at IS NULL AND COALESCE(s.is_return, false) = false
            ORDER BY s.created_at DESC
            LIMIT 10
          ) recent
         ) AS recent_sales,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'date', counted.day::text, 'revenue', counted.revenue, 'bills', counted.bills
          ) ORDER BY counted.day), '[]'::jsonb) FROM counted) AS daily`,
      [clinicId, clinicId, clinicId, clinicId, clinicId, in30Date, clinicId, clinicId, clinicId, clinicId],
    );

    const low_stock_count = Number(snapshot?.low_stock_count ?? 0);
    const expiry_count_30d = Number(snapshot?.expiry_count_30d ?? 0);
    const outstanding_receivable = Number(snapshot?.outstanding_receivable ?? 0);
    const outstanding_payable = Number(snapshot?.outstanding_payable ?? 0);
    const shortbook_count = Number(snapshot?.shortbook_count ?? 0);
    const recentSalesRaw = Array.isArray(snapshot?.recent_sales) ? snapshot.recent_sales : [];
    const dailyRows = Array.isArray(snapshot?.daily) ? snapshot.daily : [];
    const todayRow = dailyRows.find((day) => day.date === snapshot?.today);
    const today_revenue = Number(todayRow?.revenue ?? 0);
    const today_bills = Number(todayRow?.bills ?? 0);
    const week_revenue = dailyRows.reduce((sum, day) => sum + Number(day.revenue ?? 0), 0);

    const recent_activity = recentSalesRaw.map((s: any) => ({
      id: s.id,
      invoice_number: s.invoice_number,
      customer_name: s.customer_name || "Walk-in",
      net_amount: Number(s.net_amount),
      date: s.created_at,
      payment_mode: s.payment_mode || "cash",
      is_return: Boolean(s.is_return),
    }));
    const recent_sales = recent_activity.map((s) => ({
      id: s.id,
      invoice_number: s.invoice_number,
      net_amount: s.net_amount,
      created_at: s.date,
      customers: { name: s.customer_name },
    }));

    const daily_chart = dailyRows.map((day) => ({
      date: day.date,
      revenue: Number(day.revenue ?? 0),
      bills: Number(day.bills ?? 0),
    }));
    const weekly_chart = daily_chart.map((day) => ({
      day: day.date.slice(5),
      revenue: day.revenue,
    }));

    res.json({
      data: {
        today_revenue,
        today_bills,
        week_revenue,
        low_stock_count,
        expiry_count_30d,
        outstanding_receivable,
        outstanding_payable,
        shortbook_count,
        recent_sales,
        recent_activity,
        daily_chart,
        weekly_chart,
      },
    });
  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    next(err);
  }
});

// GET /api/reports/weekly
reportsRouter.get("/weekly", requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user?.clinic_id;
    if (!clinicId) {
      return res
        .status(400)
        .json({ error: "No clinic associated with this account." });
    }

    const clinic = await queryOne("clinics", "id=?", [clinicId]);
    let timeZone = String(clinic?.timezone || "Asia/Kolkata");
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone }).format();
    } catch {
      timeZone = "Asia/Kolkata";
    }
    const dateKey = (date: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    const today = dateKey(new Date());
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStr = weekAgo.toISOString();

    const salesWeek = await queryRaw<{
      net_amount: number;
      created_at: string;
      is_return: boolean;
    }>(
      `SELECT net_amount, created_at, is_return FROM sales 
       WHERE clinic_id = ? AND deleted_at IS NULL AND created_at >= ?`,
      [clinicId, weekStr],
    );

    const dailyMap: Record<string, number> = {};
    const dates: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      dates.push(dateStr);
      dailyMap[dateStr] = 0;
    }

    salesWeek.forEach((sale) => {
      const date = dateKey(new Date(sale.created_at));
      if (dailyMap[date] !== undefined) {
        dailyMap[date] += (sale.is_return ? -1 : 1) * Number(sale.net_amount);
      }
    });

    const data = dates.map((date) => ({
      date,
      revenue: dailyMap[date],
    }));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/gst-sales
reportsRouter.get("/gst-sales", requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({ error: "from and to dates required" });

    const clinicId = req.user!.clinic_id!;
    const rows = await queryRaw<{ gst_rate: number; total: number }>(
      `WITH lines AS (
         SELECT si.gst_rate, si.total, s.net_amount, COALESCE(s.is_return, false) AS is_return,
                SUM(si.total) OVER (PARTITION BY s.id) AS line_total
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si._deleted=0 AND s._deleted=0 AND s.clinic_id=? AND s.created_at>=? AND s.created_at<=?
       )
       SELECT gst_rate, SUM(CASE WHEN line_total <> 0 THEN total * net_amount / line_total ELSE 0 END
         * CASE WHEN is_return THEN -1 ELSE 1 END) AS total
       FROM lines GROUP BY gst_rate ORDER BY gst_rate`,
      [clinicId, from, to],
    );

    const data = rows.map((r) => {
      const gross = Money.round2(Number(r.total ?? 0));
      const rate = Number(r.gst_rate ?? 0);
      // Persisted line totals already include GST for both inclusive and exclusive prices.
      const taxable = Money.round2(gross / (1 + rate / 100));
      const gst = Money.round2(gross - taxable);
      const cgst = Money.round2(gst / 2);
      return {
        gst_rate: rate,
        taxable_amount: taxable,
        cgst,
        sgst: Money.round2(gst - cgst),
        total_gst: gst,
        gross_amount: gross,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/gst-purchases
reportsRouter.get("/gst-purchases", requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({ error: "from and to dates required" });

    const clinicId = req.user!.clinic_id!;
    const rows = await queryRaw<{ gst_rate: number; total: number }>(
      `SELECT pi.gst_rate, SUM(pi.total) as total
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       WHERE pi._deleted=0 AND p._deleted=0 AND p.clinic_id=? AND p.created_at>=? AND p.created_at<=?
       GROUP BY pi.gst_rate`,
      [clinicId, from, to],
    );

    const data = rows.map((r) => {
      const gross = Money.round2(Number(r.total ?? 0));
      const rate = Number(r.gst_rate ?? 0);
      // Persisted line totals already include GST for both inclusive and exclusive prices.
      const taxable = Money.round2(gross / (1 + rate / 100));
      const gst = Money.round2(gross - taxable);
      const cgst = Money.round2(gst / 2);
      return {
        gst_rate: rate,
        taxable_amount: taxable,
        cgst,
        sgst: Money.round2(gst - cgst),
        total_gst: gst,
        gross_amount: gross,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/schedule-h1
reportsRouter.get("/schedule-h1", requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const clinicId = req.user!.clinic_id!;
    const conditions = [
      "si._deleted=0",
      "s._deleted=0",
      "m.is_schedule_h1=true",
      "s.clinic_id=?",
    ];
    const values: any[] = [clinicId];

    if (from) {
      conditions.push("s.created_at>=?");
      values.push(from);
    }
    if (to) {
      conditions.push("s.created_at<=?");
      values.push(to);
    }

    const rows = await queryRaw<Record<string, any>>(
      `SELECT si.quantity, si.total, s.created_at as sale_date, s.invoice_number,
              m.name as medicine_name, c.name as customer_name, mb.batch_number
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN medicines m ON m.id = si.medicine_id
       LEFT JOIN medicine_batches mb ON mb.id = si.batch_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.created_at`,
      values,
    );

    const data = rows.map((r) => ({
      date: r.sale_date,
      invoice_number: r.invoice_number,
      customer_name: r.customer_name || "Walk-in",
      medicine_name: r.medicine_name,
      batch: r.batch_number ?? "",
      qty: r.quantity,
      amount: r.total,
    }));

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/product-wise
reportsRouter.get("/product-wise", requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const clinicId = req.user!.clinic_id!;
    const conditions = ["si._deleted=0", "s._deleted=0", "s.clinic_id=?"];
    const values: any[] = [clinicId];

    if (from) {
      conditions.push("s.created_at>=?");
      values.push(from);
    }
    if (to) {
      conditions.push("s.created_at<=?");
      values.push(to);
    }

    const rows = await queryRaw<Record<string, any>>(
      `SELECT si.medicine_id, m.name as medicine_name, SUM(si.quantity) as total_qty_sold, SUM(si.total) as total_revenue
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN medicines m ON m.id = si.medicine_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY si.medicine_id, m.name ORDER BY total_revenue DESC`,
      values,
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/party-wise
reportsRouter.get("/party-wise", requireAuth, async (req, res, next) => {
  try {
    const { type, id } = req.query;
    if (type !== "customer" && type !== "supplier") {
      return res
        .status(400)
        .json({ error: "type must be customer or supplier" });
    }

    const clinicId = req.user!.clinic_id!;

    if (type === "customer") {
      const conditions: string[] = ["clinic_id=?"];
      const values: any[] = [clinicId];
      if (id) {
        conditions.push("customer_id=?");
        values.push(id);
      }
      const where = conditions.length > 0 ? conditions.join(" AND ") : "";
      const data = await queryAll("sales", where, values);
      res.json({ data });
    } else {
      const conditions: string[] = ["clinic_id=?"];
      const values: any[] = [clinicId];
      if (id) {
        conditions.push("supplier_id=?");
        values.push(id);
      }
      const where = conditions.length > 0 ? conditions.join(" AND ") : "";
      const data = await queryAll("purchases", where, values);
      res.json({ data });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/profit-loss
reportsRouter.get("/profit-loss", requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const clinicId = req.user!.clinic_id!;

    const salesConds = ["_deleted=0", "clinic_id=?"];
    const expConds = ["_deleted=0", "clinic_id=?"];
    const sValues: any[] = [clinicId];
    const eValues: any[] = [clinicId];

    if (from) {
      salesConds.push("created_at>=?");
      sValues.push(from);
      expConds.push("expense_date>=?");
      eValues.push(from);
    }
    if (to) {
      salesConds.push("created_at<=?");
      sValues.push(to);
      expConds.push("expense_date<=?");
      eValues.push(to);
    }

    const sales = await queryRaw<{ net_amount: number; is_return: number }>(
      `SELECT net_amount, is_return FROM sales WHERE ${salesConds.join(" AND ")}`,
      sValues,
    );

    let gross_revenue = 0;
    let total_returns = 0;
    sales.forEach((s) => {
      if (s.is_return) total_returns += Math.abs(Number(s.net_amount));
      else gross_revenue += Number(s.net_amount);
    });
    const net_revenue = gross_revenue - total_returns;

    const cogs = await computeCogs(
      from as string | undefined,
      to as string | undefined,
      clinicId,
    );
    const gross_profit = net_revenue - cogs;

    const exps = await queryRaw<{ total: number }>(
      `SELECT SUM(amount) as total FROM expenses WHERE ${expConds.join(" AND ")}`,
      eValues,
    );
    const total_expenses = Number(exps[0]?.total ?? 0);

    const net_profit = gross_profit - total_expenses;
    const gross_margin_pct =
      net_revenue > 0 ? (gross_profit / net_revenue) * 100 : 0;

    res.json({
      data: {
        gross_revenue,
        total_returns,
        net_revenue,
        cogs,
        gross_profit,
        total_expenses,
        net_profit,
        gross_margin_pct,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/accounting — mobile accounting summary (alias of /accounting/summary)
reportsRouter.get("/accounting", requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id!;
    const { from, to } = req.query;
    const summary = await buildAccountingSummary(
      clinicId,
      from as string | undefined,
      to as string | undefined,
    );
    res.json({ data: toAccountingSummaryPayload(summary) });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/expiry-report
reportsRouter.get("/expiry-report", requireAuth, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days as string) || 90;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    const targetStr = targetDate.toISOString().split("T")[0];
    const clinicId = req.user!.clinic_id!;

    const data = await queryRaw(
      `SELECT mb.*, m.name as medicine_name
       FROM medicine_batches mb
       LEFT JOIN medicines m ON m.id = mb.medicine_id
       WHERE mb._deleted=0 AND mb.quantity_remaining>0 AND mb.clinic_id=? AND mb.expiry_date<=?
       ORDER BY mb.expiry_date ASC`,
      [clinicId, targetStr],
    );

    // Group by severity
    const now = new Date();
    const in30 = new Date();
    in30.setDate(now.getDate() + 30);
    const in60 = new Date();
    in60.setDate(now.getDate() + 60);

    const grouped = {
      critical: [] as any[],
      warning: [] as any[],
      watch: [] as any[],
    };
    (data as any[]).forEach((item) => {
      const exp = new Date(item.expiry_date);
      if (exp <= in30) grouped.critical.push(item);
      else if (exp <= in60) grouped.warning.push(item);
      else grouped.watch.push(item);
    });

    res.json({ data: grouped });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/slow-moving
reportsRouter.get("/slow-moving", requireAuth, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days as string) || 60;
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);
    const fromStr = threshold.toISOString();
    const clinicId = req.user!.clinic_id!;

    // Get medicines that had zero sales in the period
    const solMap: Record<string, number> = {};
    const salesData = await queryRaw<{ medicine_id: string; quantity: number }>(
      `SELECT si.medicine_id, si.quantity
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE si._deleted=0 AND s._deleted=0 AND s.clinic_id=? AND s.created_at>=?`,
      [clinicId, fromStr],
    );
    salesData.forEach((s) => {
      solMap[s.medicine_id] = (solMap[s.medicine_id] || 0) + s.quantity;
    });

    const medicines = await queryRaw<Record<string, any>>(
      `SELECT m.id, m.name, COALESCE(SUM(mb.quantity_remaining), 0) as current_stock
       FROM medicines m
       LEFT JOIN medicine_batches mb ON mb.medicine_id = m.id AND mb._deleted=0 AND mb.clinic_id=?
       WHERE m._deleted=0 AND m.is_active=true AND m.clinic_id=?
       GROUP BY m.id, m.name`,
      [clinicId, clinicId],
    );

    const slow = medicines
      .filter((m) => (solMap[m.id] || 0) === 0 && Number(m.current_stock) > 0)
      .map((m) => ({
        id: m.id,
        name: m.name,
        sold: 0,
        current_stock: Number(m.current_stock),
      }));

    res.json({ data: slow });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/gstr1-export?month=1&year=2025
reportsRouter.get("/gstr1-export", requireAuth, async (req, res, next) => {
  try {
    const month = parseInt(req.query.month as string, 10);
    const year = parseInt(req.query.year as string, 10);
    if (
      !month ||
      month < 1 ||
      month > 12 ||
      !year ||
      year < 2000 ||
      year > 2100
    ) {
      return res
        .status(400)
        .json({ error: { message: "Valid month (1-12) and year required" } });
    }

    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0)).toISOString();
    const end = new Date(
      Date.UTC(year, month, 0, 23, 59, 59, 999),
    ).toISOString();
    const clinicId = req.user!.clinic_id!;

    const clinic = (await queryOne("clinics", "id=?", [clinicId])) as any;

    const salesRaw = await queryRaw<Record<string, any>>(
      `SELECT s.id, s.invoice_number, s.created_at as sale_date, s.net_amount, c.gstin as customer_gstin
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s._deleted=0 AND s.is_return=false AND s.clinic_id=? AND s.created_at>=? AND s.created_at<=?`,
      [clinicId, start, end],
    );

    const sales: SaleRowForGstr1[] = await Promise.all(
      salesRaw.map(async (s) => {
        const items = await queryRaw<Record<string, any>>(
          `SELECT si.total, si.gst_rate, si.quantity, m.hsn_code, m.name as medicine_name
         FROM sale_items si
         LEFT JOIN medicines m ON m.id = si.medicine_id
         WHERE si._deleted=0 AND si.sale_id=?`,
          [s.id],
        );

        return {
          invoice_number: s.invoice_number,
          sale_date: s.sale_date,
          net_amount: Number(s.net_amount),
          customer_gstin: s.customer_gstin || null,
          items: items.map((it) => ({
            total: Number(it.total),
            gst_rate: Number(it.gst_rate),
            quantity: it.quantity,
            hsn_code: it.hsn_code || null,
            medicine_name: it.medicine_name || "",
          })),
        };
      }),
    );

    const payload = buildGstr1Payload(clinic?.gstin || "", month, year, sales);
    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});

export default reportsRouter;
