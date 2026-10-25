import express from 'express';
import request from 'supertest';
import { reportsRouter } from '../routes/reports';
import { queryAll, queryOne, queryRaw } from '../lib/postgresDb';

jest.mock('../lib/postgresDb', () => ({
  queryRaw: jest.fn(), queryCount: jest.fn(), queryOne: jest.fn(),
  queryAll: jest.fn(), localMutate: jest.fn(),
}));
jest.mock('../local-db', () => ({ localDb: {} }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'owner', clinic_id: 'clinic-a' };
    next();
  },
}));

const app = express();
app.use('/reports', reportsRouter);
const raw = jest.mocked(queryRaw);

beforeEach(() => {
  jest.resetAllMocks();
  raw.mockResolvedValue([]);
});

test('the dashboard is one database query and keeps the same response', async () => {
  raw.mockResolvedValueOnce([{
    today: '2026-10-25',
    low_stock_count: 2, expiry_count_30d: 3, outstanding_receivable: '300.50', outstanding_payable: '40.25', shortbook_count: 1,
    recent_sales: [{ id: 'sale-1', invoice_number: 'INV-1', net_amount: '100.00', created_at: '2026-10-25T05:00:00.000Z', payment_mode: 'upi', is_return: false, customer_name: null }],
    daily: [
      { date: '2026-10-19', revenue: 0, bills: 0 },
      { date: '2026-10-25', revenue: 80, bills: 1 },
    ],
  }]);
  const response = await request(app).get('/reports/dashboard');
  expect(response.status).toBe(200);
  expect(raw).toHaveBeenCalledTimes(1);
  expect(jest.mocked(queryOne)).not.toHaveBeenCalled();
  expect(jest.mocked(queryAll)).not.toHaveBeenCalled();
  expect(raw.mock.calls[0][1]).toEqual(['clinic-a', 'clinic-a', 'clinic-a', 'clinic-a', 'clinic-a', expect.any(String), 'clinic-a', 'clinic-a', 'clinic-a', 'clinic-a']);
  expect(response.body.data).toMatchObject({
    low_stock_count: 2, expiry_count_30d: 3, outstanding_receivable: 300.5, outstanding_payable: 40.25, shortbook_count: 1,
    today_revenue: 80, today_bills: 1, week_revenue: 80,
  });
  expect(response.body.data.daily_chart.map((day: { date: string }) => day.date)).toEqual(['2026-10-19', '2026-10-25']);
  expect(response.body.data.recent_activity).toEqual([{
    id: 'sale-1', invoice_number: 'INV-1', customer_name: 'Walk-in', net_amount: 100,
    date: '2026-10-25T05:00:00.000Z', payment_mode: 'upi', is_return: false,
  }]);
});

test('a store without data reports zero counters', async () => {
  const response = await request(app).get('/reports/dashboard');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    low_stock_count: 0, expiry_count_30d: 0, outstanding_receivable: 0, outstanding_payable: 0, shortbook_count: 0,
    today_revenue: 0, recent_activity: [], daily_chart: [],
  });
});
