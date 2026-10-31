import { randomUUID } from "node:crypto";
const database = process.env.TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.endsWith("_qa")
  )
    throw new Error("Write tests require a disposable local *_qa database");
  process.env.DATABASE_URL = database;
}
jest.mock("../../middleware/planEnforcement", () => ({
  enforcePlan: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import sql from "../../db";
import { localDb } from "../../local-db";
import { salesRouter } from "../../routes/sales";
import { purchasesRouter } from "../../routes/purchases";
import { inventoryRouter } from "../../routes/inventory";
import { reportsRouter } from "../../routes/reports";
import { expensesRouter } from "../../routes/expenses";
import { suppliersRouter } from "../../routes/suppliers";
import { customersRouter } from "../../routes/customers";
import { backupRouter } from "../../routes/backup";
import { errorHandler } from "../../middleware/errorHandler";

const describePg = database ? describe : describe.skip;
describePg("Cloud documents against PostgreSQL", () => {
  const clinic = randomUUID(),
    user = randomUUID(),
    med = randomUUID(),
    otherMed = randomUUID(),
    batch = randomUUID(),
    supplier = randomUUID();
  const app = express();
  app.use(express.json());
  app.use("/sales", salesRouter);
  app.use("/purchases", purchasesRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/backup", backupRouter);
  app.use("/customers", customersRouter);
  app.use("/reports", reportsRouter);
  app.use("/expenses", expensesRouter);
  app.use("/suppliers", suppliersRouter);
  app.use(errorHandler);
  const token = jwt.sign(
    { sub: user, clinic_id: clinic, role: "OWNER" },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" },
  );
  const post = (path: string, data: object) =>
    request(app).post(path).set("Authorization", `Bearer ${token}`).send(data);
  const get = (path: string) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);
  const line = (quantity: number) => ({
    medicine_id: med,
    batch_id: batch,
    quantity,
    mrp: 20,
    gst_rate: 12,
  });
  const stock = async () =>
    Number(
      (
        await sql`SELECT quantity_remaining FROM medicine_batches WHERE id = ${batch}`
      )[0].quantity_remaining,
    );
  let sale: any;
  beforeAll(async () => {
    await sql`INSERT INTO auth.users(id) VALUES(${user})`;
    await sql`INSERT INTO clinics(id,_local_id,name,slug) VALUES(${clinic},${clinic},'Write QA',${clinic})`;
    await sql`INSERT INTO users(id,_local_id,clinic_id,full_name,email,role) VALUES(${user},${user},${clinic},'Write QA owner',${`${user}@example.invalid`},'OWNER')`;
    localDb
      .prepare(
        "INSERT INTO users(id,_local_id,clinic_id,role,_updated_at) VALUES(?,?,?,?,?)",
      )
      .run(user, user, clinic, "OWNER", new Date().toISOString());
    await sql`INSERT INTO suppliers(id,_local_id,clinic_id,name) VALUES(${supplier},${supplier},${clinic},'Write QA supplier')`;
    for (const id of [med, otherMed])
      await sql`INSERT INTO medicines(id,_local_id,clinic_id,name) VALUES(${id},${id},${clinic},'Write QA medicine')`;
    await sql`INSERT INTO medicine_batches(id,_local_id,clinic_id,medicine_id,supplier_id,batch_number,expiry_date,mrp,purchase_price,quantity_in,quantity_remaining) VALUES(${batch},${batch},${clinic},${med},${supplier},'WRITE-QA','2031-12-31',20,10,10,10)`;
  });
  afterAll(async () => {
    for (const table of [
      "audit_logs",
      "expenses",
      "purchase_return_lines",
      "purchase_returns",
      "stock_ledger",
      "sale_items",
      "sales",
      "purchase_items",
      "medicine_batches",
      "purchases",
      "purchase_orders",
      "medicines",
      "suppliers",
      "customers",
      "clinic_invoice_sequences",
    ])
      await sql`DELETE FROM ${sql(table)} WHERE clinic_id = ${clinic}`;
    await sql`DELETE FROM users WHERE id = ${user}`;
    await sql`DELETE FROM clinics WHERE id = ${clinic}`;
    await sql`DELETE FROM auth.users WHERE id = ${user}`;
    localDb.prepare("DELETE FROM users WHERE id = ?").run(user);
    await sql.end();
  });
  test("schedule-H1 report executes with PostgreSQL boolean columns", async () => {
    const response = await get('/reports/schedule-h1');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
  test("201 is sent only after invoice, items, ledger and stock persist", async () => {
    const res = await post("/sales", { paid_amount: 40, items: [line(2)] });
    expect(res.status).toBe(201);
    sale = res.body.data;
    expect((await sql`SELECT id FROM sales WHERE id = ${sale.id}`).length).toBe(
      1,
    );
    expect(await stock()).toBe(8);
    expect(
      Number(
        (
          await sql`SELECT quantity_delta FROM stock_ledger WHERE reference_id = ${sale.id}`
        )[0].quantity_delta,
      ),
    ).toBe(-2);
  });
  test("duplicate lines cannot collectively exceed stock or create partial invoices", async () => {
    const before = Number(
      (await sql`SELECT count(*) FROM sales WHERE clinic_id = ${clinic}`)[0]
        .count,
    );
    expect((await post("/sales", { items: [line(5), line(5)] })).status).toBe(
      409,
    );
    expect(
      Number(
        (await sql`SELECT count(*) FROM sales WHERE clinic_id = ${clinic}`)[0]
          .count,
      ),
    ).toBe(before);
    expect(await stock()).toBe(8);
  });
  test("mismatched medicine and batch are rejected", async () => {
    expect(
      (await post("/sales", { items: [{ ...line(1), medicine_id: otherMed }] }))
        .status,
    ).toBe(400);
  });
  test("concurrent billing cannot oversell", async () => {
    const responses = await Promise.all([
      post("/sales", { items: [line(5)] }),
      post("/sales", { items: [line(5)] }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stock()).toBe(3);
  });
  test("sold units cannot be returned twice", async () => {
    const payload = {
      original_sale_id: sale.id,
      items: [{ sale_item_id: sale.sale_items[0].id, quantity: 2 }],
    };
    expect((await post("/sales/returns", payload)).status).toBe(200);
    expect((await post("/sales/returns", payload)).status).toBe(400);
    expect(await stock()).toBe(5);
  });
  test("failed purchase rolls back header, lines and stock", async () => {
    const before = Number(
      (await sql`SELECT count(*) FROM purchases WHERE clinic_id = ${clinic}`)[0]
        .count,
    );
    const valid = {
      medicine_id: med,
      batch_number: "ROLLBACK-QA",
      expiry_date: "2031-12-31",
      quantity: 3,
      purchase_price: 10,
      mrp: 20,
      gst_rate: 12,
    };
    expect(
      (
        await post("/purchases", {
          supplier_id: supplier,
          invoice_number: "ROLLBACK-QA",
          items: [valid, { ...valid, medicine_id: randomUUID() }],
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      Number(
        (
          await sql`SELECT count(*) FROM purchases WHERE clinic_id = ${clinic}`
        )[0].count,
      ),
    ).toBe(before);
    expect(
      (
        await sql`SELECT id FROM medicine_batches WHERE clinic_id = ${clinic} AND batch_number = 'ROLLBACK-QA'`
      ).length,
    ).toBe(0);
  });
  test("purchase accepts omitted optional fields and commits stock", async () => {
    const res = await post("/purchases", {
      supplier_id: supplier,
      invoice_number: "SUCCESS-QA",
      items: [
        {
          medicine_id: med,
          batch_number: "SUCCESS-QA",
          expiry_date: "2031-12-31",
          quantity: 3,
          purchase_price: 10,
          mrp: 20,
          gst_rate: 12,
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(
      Number(
        (
          await sql`SELECT quantity_remaining FROM medicine_batches WHERE clinic_id = ${clinic} AND batch_number = 'SUCCESS-QA'`
        )[0].quantity_remaining,
      ),
    ).toBe(3);
  });
  test("supplier return rejects negative quantity without changing stock", async () => {
    expect(
      (
        await post("/purchases/purchase-returns", {
          supplier_id: supplier,
          lines: [{ batchId: batch, quantity: -2 }],
        })
      ).status,
    ).toBe(400);
    expect(await stock()).toBe(5);
  });
  test("static purchase routes and batch selector are reachable", async () => {
    for (const path of [
      "/purchases/purchase-orders",
      "/purchases/purchase-returns",
      "/inventory/batches?limit=100",
    ])
      expect((await get(path)).status).toBe(200);
  });
  test("inclusive POS prices, discounts, payment and returns agree", async () => {
    const customer = await post("/customers", {
      name: "Credit QA",
      phone: "9000000003",
      credit_limit: 25,
    });
    expect(customer.status).toBe(201);
    expect(Number(customer.body.data.credit_limit)).toBe(25);
    const saved = await post("/sales", {
      customer_id: customer.body.data.id,
      price_includes_tax: true,
      paid_amount: 10,
      payment_mode: "credit",
      items: [{ ...line(1), discount_pct: 10 }],
    });
    expect(saved.status).toBe(201);
    expect(Number(saved.body.data.net_amount)).toBe(18);
    expect(Number(saved.body.data.balance_due)).toBe(8);
    expect(Number(saved.body.data.sale_items[0].total)).toBe(18);
    const rejected = await post("/sales", {
      customer_id: customer.body.data.id,
      price_includes_tax: true,
      paid_amount: 0,
      items: [line(1)],
    });
    expect(rejected.status).toBe(409);
    const returned = await post("/sales/returns", {
      original_sale_id: saved.body.data.id,
      items: [{ sale_item_id: saved.body.data.sale_items[0].id, quantity: 1 }],
    });
    expect(returned.status).toBe(200);
    expect(Number(returned.body.data.net_amount)).toBe(18);
    expect(
      Number(
        (
          await sql`SELECT outstanding_balance FROM customers WHERE id = ${customer.body.data.id}`
        )[0].outstanding_balance,
      ),
    ).toBe(0);
  });
  test("GST summaries reconcile inclusive prices, bill discounts, returns and purchase discounts", async () => {
    const period = { from: '2030-01-01T00:00:00Z', to: '2030-12-31T23:59:59Z' };
    const invoiceId = randomUUID(), returnId = randomUUID();
    for (const [id, amount, isReturn] of [[invoiceId, 112, false], [returnId, 56, true]] as const) {
      await sql`INSERT INTO sales(id,_local_id,clinic_id,invoice_number,subtotal,net_amount,is_return,created_at) VALUES(${id},${id},${clinic},${id},${amount},${amount},${isReturn},'2030-06-01')`;
      const itemId = randomUUID();
      // Header amount includes a bill-level discount from the line's original gross total.
      await sql`INSERT INTO sale_items(id,_local_id,clinic_id,sale_id,medicine_id,batch_id,quantity,unit_price,gst_rate,total) VALUES(${itemId},${itemId},${clinic},${id},${med},${batch},1,140,12,140)`;
    }
    const salesGst = await get(`/reports/gst-sales?${new URLSearchParams(period)}`);
    expect(salesGst.status).toBe(200);
    expect(salesGst.body.data).toEqual([{gst_rate:12,taxable_amount:50,cgst:3,sgst:3,total_gst:6,gross_amount:56}]);
    const purchase = await post('/purchases', {supplier_id:supplier,invoice_number:randomUUID(),invoice_date:'2030-06-01',items:[{medicine_id:med,batch_number:randomUUID(),expiry_date:'2031-12-31',quantity:2,purchase_price:100,mrp:150,gst_rate:12,discount:10}]});
    expect(purchase.status).toBe(201);
    expect(Number(purchase.body.data.discount)).toBe(20);
    expect(Number(purchase.body.data.net_amount)).toBe(201.6);
    await sql`UPDATE purchases SET created_at='2030-06-01' WHERE id=${purchase.body.data.id}`;
    const purchaseGst = await get(`/reports/gst-purchases?${new URLSearchParams(period)}`);
    expect(purchaseGst.status).toBe(200);
    expect(purchaseGst.body.data).toEqual([{gst_rate:12,taxable_amount:180,cgst:10.8,sgst:10.8,total_gst:21.6,gross_amount:201.6}]);
  });
  test("supplier optional fields and expense location context are valid", async () => {
    expect(
      (await post("/suppliers", { name: "Optional QA supplier" })).status,
    ).toBe(201);
    const expense = await post("/expenses", {
      category: "misc",
      amount: 25,
      expense_date: "2026-10-08",
      payment_mode: "cash",
    });
    expect(expense.status).toBe(201);
    expect(expense.body.data.organization_id).toBeNull();
    expect(
      (await get("/expenses")).body.data.some(
        (row: { id: string }) => row.id === expense.body.data.id,
      ),
    ).toBe(true);
  });
  test("invoice HTML never discloses another clinic invoice", async () => {
    const otherUser = randomUUID(), otherClinic = randomUUID();
    await sql`INSERT INTO auth.users(id) VALUES(${otherUser})`;
    await sql`INSERT INTO clinics(id,_local_id,name,slug) VALUES(${otherClinic},${otherClinic},'Other QA',${otherClinic})`;
    await sql`INSERT INTO users(id,_local_id,clinic_id,full_name,email,role) VALUES(${otherUser},${otherUser},${otherClinic},'Other QA owner',${`${otherUser}@example.invalid`},'OWNER')`;
    localDb.prepare('INSERT INTO users(id,_local_id,clinic_id,role,_updated_at) VALUES(?,?,?,?,?)').run(otherUser, otherUser, otherClinic, 'OWNER', new Date().toISOString());
    const otherToken = jwt.sign(
      { sub: otherUser, clinic_id: otherClinic, role: "OWNER" },
      process.env.JWT_SECRET!,
    );
    try {
      const response = await request(app)
      .get(`/sales/${sale.id}/invoice`)
      .set("Authorization", `Bearer ${otherToken}`);
      expect(response.status).toBe(404);
    } finally {
      localDb.prepare('DELETE FROM users WHERE id = ?').run(otherUser);
      await sql`DELETE FROM users WHERE id = ${otherUser}`;
      await sql`DELETE FROM clinics WHERE id = ${otherClinic}`;
      await sql`DELETE FROM auth.users WHERE id = ${otherUser}`;
    }
  });
  test("receipts reduce invoice and party balances exactly once under concurrency", async () => {
    const customer = await post("/customers", {
      name: "Receipt QA",
      phone: "9000000005",
      credit_limit: 100,
    });
    const invoice = await post("/sales", {
      customer_id: customer.body.data.id,
      price_includes_tax: true,
      paid_amount: 0,
      payment_mode: "credit",
      items: [line(1)],
    });
    expect(invoice.status).toBe(201);
    expect(
      (
        await post(`/customers/${customer.body.data.id}/payment`, {
          amount: 7,
          payment_mode: "cash",
        })
      ).status,
    ).toBe(200);
    expect(
      Number(
        (
          await sql`SELECT balance_due FROM sales WHERE id=${invoice.body.data.id}`
        )[0].balance_due,
      ),
    ).toBe(13);
    const receipts = await Promise.all([
      post(`/customers/${customer.body.data.id}/payment`, {
        amount: 13,
        payment_mode: "upi",
      }),
      post(`/customers/${customer.body.data.id}/payment`, {
        amount: 13,
        payment_mode: "upi",
      }),
    ]);
    expect(receipts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      Number(
        (
          await sql`SELECT outstanding_balance FROM customers WHERE id=${customer.body.data.id}`
        )[0].outstanding_balance,
      ),
    ).toBe(0);
    expect(
      (
        await sql`SELECT id FROM audit_logs WHERE clinic_id=${clinic} AND record_id=${customer.body.data.id}`
      ).length,
    ).toBe(2);
    const payment = await post(`/suppliers/${supplier}/payment`, { amount: 5 });
    expect(payment.status).toBe(200);
  });
  test("dashboard groups local business days and subtracts return documents", async () => {
    const response = await get("/reports/dashboard");
    expect(response.status).toBe(200);
    const [expected] =
      await sql`SELECT SUM(CASE WHEN is_return THEN -net_amount ELSE net_amount END) AS revenue FROM sales WHERE clinic_id=${clinic} AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
    expect(response.body.data.today_revenue).toBeCloseTo(
      Number(expected.revenue),
      2,
    );
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    expect(response.body.data.daily_chart.at(-1).date).toBe(today);
    expect(response.body.data.daily_chart.at(-1).revenue).toBeCloseTo(
      Number(expected.revenue),
      2,
    );
  });
  test("backup export and restore preserve existing invoices", async () => {
    const exported = await get("/backup/export");
    expect(exported.status).toBe(200);
    expect(exported.body.complete).toBe(true);
    const count = Number(
      (await sql`SELECT count(*) FROM sales WHERE clinic_id = ${clinic}`)[0]
        .count,
    );
    expect(
      (await post("/backup/import", { data: exported.body.data })).status,
    ).toBe(200);
    expect(
      Number(
        (await sql`SELECT count(*) FROM sales WHERE clinic_id = ${clinic}`)[0]
          .count,
      ),
    ).toBe(count);
  });
  test("backup tenant mismatch is rejected", async () => {
    expect(
      (
        await post("/backup/import", {
          data: {
            medicines: [
              { id: med, clinic_id: randomUUID(), name: "Wrong tenant" },
            ],
          },
        })
      ).status,
    ).toBe(403);
  });
});
