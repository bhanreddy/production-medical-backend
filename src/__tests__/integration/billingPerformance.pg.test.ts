import { randomUUID } from 'node:crypto';
const database = process.env.TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_qa'))
    throw new Error('Write tests require a disposable local *_qa database');
  process.env.DATABASE_URL = database;
}
const clinic = randomUUID(), operator = randomUUID();
jest.mock('../../middleware/auth', () => ({ requireAuth: (req: any, _res: any, next: any) => {
  req.user = { id: operator, clinic_id: clinic, role: 'OWNER' }; next();
} }));
jest.mock('../../middleware/planEnforcement', () => ({ enforcePlan: (_req: any, _res: any, next: any) => next() }));
jest.mock('../../services/dailySalesSummary', () => ({ DailySalesSummaryService: { refresh: jest.fn() } }));
import express from 'express';
import request from 'supertest';
import sql from '../../db';
import * as persistence from '../../lib/postgresDb';
import { salesRouter } from '../../routes/sales';
import { inventoryRouter } from '../../routes/inventory';
import { reportsRouter } from '../../routes/reports';
import { errorHandler } from '../../middleware/errorHandler';

(database ? describe : describe.skip)('Billing performance with real PostgreSQL transactions', () => {
  const medicines = Array.from({ length: 10 }, () => ({ id: randomUUID(), batch: randomUUID() }));
  const app = express(); app.use(express.json()); app.use('/sales', salesRouter);
  app.use('/inventory', inventoryRouter); app.use('/reports', reportsRouter); app.use(errorHandler);
  const lines = medicines.map(medicine => ({ medicine_id: medicine.id, batch_id: medicine.batch, quantity: 2, mrp: 20, gst_rate: 12 }));
  afterEach(() => jest.restoreAllMocks());
  beforeAll(async () => {
    await sql`CREATE TABLE IF NOT EXISTS clinic_invoice_sequences (clinic_id uuid REFERENCES clinics(id), sequence_date date, last_value integer, PRIMARY KEY(clinic_id, sequence_date))`;
    await sql`INSERT INTO clinics(id, _local_id, name, slug) VALUES(${clinic},${clinic},'Billing performance QA',${clinic})`;
    await sql`INSERT INTO users(id, email, full_name, role) VALUES(${operator},${`${operator}@example.invalid`},'QA cashier','OWNER')`;
    for (const [index, medicine] of medicines.entries()) {
      await sql`INSERT INTO medicines(id, _local_id, clinic_id, name, generic_name, barcode) VALUES(${medicine.id},${medicine.id},${clinic},${`Performance medicine ${index}`},'Generic performance','123456')`;
      await sql`INSERT INTO medicine_batches(id, _local_id, clinic_id, medicine_id, batch_number, expiry_date, mrp, purchase_price, quantity_in, quantity_remaining) VALUES(${medicine.batch},${medicine.batch},${clinic},${medicine.id},${`QA-${index}`},'2099-12-31',20,10,50,50)`;
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    for (const table of ['stock_ledger','sale_items','sales','medicine_batches','medicines','clinic_invoice_sequences'])
      await sql`DELETE FROM ${sql(table)} WHERE clinic_id = ${clinic}`;
    await sql`DELETE FROM clinic_subscriptions WHERE clinic_id = ${clinic}`;
    await sql`DELETE FROM subscription_plans WHERE name = ${clinic}`;
    await sql`DELETE FROM users WHERE id = ${operator}`;
    await sql`DELETE FROM clinics WHERE id = ${clinic}`;
    await sql.end();
  });
  test('the combined plan query uses current subscription limits without skipping inactive accounts', async () => {
    const { enforcePlan } = jest.requireActual('../../middleware/planEnforcement');
    const req = { user: { clinic_id: clinic }, method: 'POST', originalUrl: '/api/sales' } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
    const next = jest.fn();
    await sql`INSERT INTO subscription_plans(name, display_name, limits) VALUES(${clinic},'QA plan',${sql.json({ max_daily_bills: 100 })})`;
    await sql`INSERT INTO clinic_subscriptions(clinic_id, status, plan_name) VALUES(${clinic},'active',${clinic})`;
    const spy = jest.spyOn(persistence, 'queryRaw');
    await enforcePlan(req, res, next);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.planLimits.max_daily_bills).toBe(100);
    await sql`UPDATE clinic_subscriptions SET status = 'cancelled' WHERE clinic_id = ${clinic}`;
    next.mockClear();
    await enforcePlan(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test('an empty sales calendar reports zero invoices, and out-of-stock medicines are counted', async () => {
    const empty = await request(app).get('/reports/dashboard');
    expect(empty.status).toBe(200);
    expect(empty.body.data.today_bills).toBe(0);
    expect(empty.body.data.daily_chart).toHaveLength(7);
    expect(empty.body.data.daily_chart.every((day: {bills:number}) => day.bills === 0)).toBe(true);
    await sql`UPDATE medicine_batches SET quantity_remaining = 0 WHERE id = ${medicines[9].batch}`;
    expect((await request(app).get('/reports/dashboard')).body.data.low_stock_count).toBe(1);
    await sql`UPDATE medicine_batches SET quantity_remaining = 50 WHERE id = ${medicines[9].batch}`;
  });
  test('search returns sellable batches and correct stock in one query, including barcode and empty stock', async () => {
    const spy = jest.spyOn(persistence, 'queryRaw');
    const response = await request(app).get('/inventory/medicines/search?q=performance&include_substitutes=false');
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(response.body.results).toHaveLength(10);
    expect(Number(response.body.results[0].total_stock)).toBe(50);
    expect(response.body.results[0].medicine_batches[0].batch_number).toBe('QA-0');
    spy.mockRestore();
    expect((await request(app).get('/inventory/medicines/search?barcode=123456&limit=1&include_substitutes=false')).body.results).toHaveLength(1);
    expect((await request(app).get('/inventory/medicines/search?q=missing&include_substitutes=false')).body.results).toEqual([]);
  });
  test('ten-line sale uses two bulk inserts and one stock update and commits all balances before 201', async () => {
    const inserts = jest.spyOn(persistence, 'localInsertMany');
    const reads = jest.spyOn(persistence, 'queryRaw');
    const response = await request(app).post('/sales').send({ items: lines, price_includes_tax: true, paid_amount: 400 });
    expect(response.status).toBe(201);
    expect(inserts.mock.calls.map(call => [call[0], call[1].length])).toEqual([['sale_items', 10], ['stock_ledger', 10]]);
    expect(reads.mock.calls.filter(call => call[0].startsWith('UPDATE medicine_batches'))).toHaveLength(1);
    expect(response.body.data.sale_items.map((line: any) => line.medicine_id)).toEqual(medicines.map(medicine => medicine.id));
    const stock = await sql`SELECT quantity_remaining FROM medicine_batches WHERE clinic_id = ${clinic}`;
    expect(stock.map(row => Number(row.quantity_remaining))).toEqual(Array(10).fill(48));
    const ledger = await sql`SELECT quantity_delta FROM stock_ledger WHERE reference_id = ${response.body.data.id}`;
    expect(ledger).toHaveLength(10);
    inserts.mockRestore(); reads.mockRestore();
  });
  test('duplicate batch lines deduct their combined quantity, preserving per-line ledger balances', async () => {
    const response = await request(app).post('/sales').send({ items: [{ ...lines[0], quantity: 2 }, { ...lines[0], quantity: 3 }] });
    expect(response.status).toBe(201);
    expect(Number((await sql`SELECT quantity_remaining FROM medicine_batches WHERE id = ${medicines[0].batch}`)[0].quantity_remaining)).toBe(43);
    const ledger = await sql`SELECT balance_after FROM stock_ledger WHERE reference_id = ${response.body.data.id} ORDER BY balance_after DESC`;
    expect(ledger.map(row => row.balance_after)).toEqual([46, 43]);
  });
  test('concurrent sales still lock stock and cannot oversell', async () => {
    const body = { items: [{ ...lines[0], quantity: 30 }] };
    const responses = await Promise.all([request(app).post('/sales').send(body), request(app).post('/sales').send(body)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(Number((await sql`SELECT quantity_remaining FROM medicine_batches WHERE id = ${medicines[0].batch}`)[0].quantity_remaining)).toBe(13);
  });
  test('ledger failure rolls back the invoice, bulk items and stock update', async () => {
    const before = await sql`SELECT count(*)::int AS count FROM sales WHERE clinic_id = ${clinic}`;
    const original = persistence.localInsertMany;
    const spy = jest.spyOn(persistence, 'localInsertMany').mockImplementation((table, rows) => {
      if (table === 'stock_ledger') throw new Error('Isolated ledger failure');
      return original(table, rows);
    });
    const response = await request(app).post('/sales').send({ items: [lines[1]] });
    expect(response.status).toBe(500);
    expect((await sql`SELECT count(*)::int AS count FROM sales WHERE clinic_id = ${clinic}`)[0].count).toBe(before[0].count);
    expect(Number((await sql`SELECT quantity_remaining FROM medicine_batches WHERE id = ${medicines[1].batch}`)[0].quantity_remaining)).toBe(48);
    spy.mockRestore();
  });
});
