import express from 'express';
import request from 'supertest';
import { inventoryRouter } from '../routes/inventory';
import { queryAll, queryRaw } from '../lib/postgresDb';

jest.mock('../lib/postgresDb', () => ({
  queryRaw: jest.fn(), queryCount: jest.fn(), queryOne: jest.fn(),
  queryAll: jest.fn(), localMutate: jest.fn(),
}));
jest.mock('../local-db', () => ({ localDb: {} }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'cashier', clinic_id: 'clinic-a' };
    next();
  },
}));

const app = express();
app.use('/inventory', inventoryRouter);
const raw = jest.mocked(queryRaw);
const all = jest.mocked(queryAll);

beforeEach(() => {
  raw.mockReset();
  raw.mockResolvedValue([]);
  all.mockReset();
});

test('billing search returns scoped FEFO stock in one bounded query', async () => {
  raw.mockResolvedValueOnce([{ id: 'med-cloud', _local_id: 'med-local', name: 'Medicine', total_stock: 10,
    medicine_batches: [
      { id: 'early', expiry_date: '2098-01-01', quantity_remaining: 3 },
      { id: 'late', expiry_date: '2099-01-01', quantity_remaining: 7 },
    ] }]);
  const response = await request(app).get('/inventory/medicines/search?q=Medicine&include_substitutes=false');
  expect(response.status).toBe(200);
  expect(raw).toHaveBeenCalledTimes(1);
  expect(raw.mock.calls[0][0]).toContain('LEFT JOIN LATERAL');
  expect(raw.mock.calls[0][0]).toContain('b.clinic_id = page.clinic_id');
  expect(raw.mock.calls[0][0]).toContain('b.expiry_date >= ?');
  expect(raw.mock.calls[0][0]).toContain('b.is_disposed = false');
  expect(raw.mock.calls[0][1]).toEqual(['%Medicine%', '%Medicine%', 'clinic-a', 'Medicine', 'Medicine%', 25, expect.any(String), 'Medicine', 'Medicine%']);
  expect(response.body.results[0].total_stock).toBe(10);
  expect(response.body.results[0].medicine_batches.map((batch: any) => batch.id)).toEqual(['early', 'late']);
  expect(response.body.substitutes).toEqual([]);
});

test('barcode search uses the same one-query stock snapshot without name ranking parameters', async () => {
  await request(app).get('/inventory/medicines/search?barcode=123456&include_substitutes=false');
  expect(raw).toHaveBeenCalledTimes(1);
  expect(raw.mock.calls[0][1]).toEqual(['123456', 'clinic-a', 25, expect.any(String)]);
});

test('substitute lookups are bounded and scoped to the authenticated clinic', async () => {
  raw.mockResolvedValueOnce([{ id: 'med', name: 'Medicine', generic_name: 'Generic' }])
    .mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'substitute', name: 'Alternative' }]);
  const response = await request(app).get('/inventory/medicines/search?q=Medicine&limit=10000');
  expect(raw.mock.calls[0][1]?.at(-1)).toBe(100);
  expect(raw.mock.calls[2][0]).toContain('clinic_id=?');
  expect(raw.mock.calls[2][0]).toContain('LIMIT 100');
  expect(raw.mock.calls[2][1]).toEqual(['Generic', 'clinic-a']);
  expect(response.body.substitutes[0].id).toBe('substitute');
});

test('empty search performs no database reads', async () => {
  const response = await request(app).get('/inventory/medicines/search?q=%20');
  expect(response.body).toEqual({ results: [], substitutes: [] });
  expect(raw).not.toHaveBeenCalled();
});

test('attention counts use one aggregated query scoped to the clinic and the requested dates', async () => {
  raw.mockResolvedValueOnce([{ low_stock: 2, expiring: 3, shortbook: 4 }]);
  const response = await request(app).get('/inventory/attention-counts?today=2026-10-25&warning=2026-11-24');
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual({ low_stock: 2, expiring: 3, shortbook: 4 });
  expect(raw).toHaveBeenCalledTimes(1);
  expect(raw.mock.calls[0][0]).toContain('GREATEST(COALESCE(m.low_stock_threshold, 10), 1)');
  expect(raw.mock.calls[0][0]).toContain('is_ordered = false');
  expect(raw.mock.calls[0][1]).toEqual(['clinic-a', 'clinic-a', '2026-10-25', '2026-10-25', '2026-10-25', '2026-11-24', 'clinic-a']);
  expect(all).not.toHaveBeenCalled();
});

test('medicine list reads products and their stock together and groups stock per product', async () => {
  let resolveMedicines: (rows: any[]) => void = () => {};
  all.mockReturnValue(new Promise(resolve => { resolveMedicines = resolve; }));
  raw.mockImplementation(async () => {
    resolveMedicines([
      { id: 'med-a', name: 'A', low_stock_threshold: 10 },
      { id: 'med-b', name: 'B', low_stock_threshold: 3 },
    ]);
    return [
      { id: 'a-1', medicine_id: 'med-a', quantity_remaining: 3 },
      { id: 'b-1', medicine_id: 'med-b', quantity_remaining: 4 },
      { id: 'a-2', medicine_id: 'med-a', quantity_remaining: 4 },
    ];
  });
  const response = await request(app).get('/inventory/medicines?q=Para&low_stock=true');
  expect(response.status).toBe(200);
  const where = 'is_active=true AND clinic_id=? AND (name ILIKE ? OR generic_name ILIKE ?)';
  expect(all.mock.calls[0].slice(1)).toEqual([where, ['clinic-a', '%Para%', '%Para%']]);
  expect(raw.mock.calls[0][0]).toContain(`medicine_id IN (SELECT id FROM medicines WHERE deleted_at IS NULL AND (${where}))`);
  expect(raw.mock.calls[0][1]).toEqual(['clinic-a', '%Para%', '%Para%', 'clinic-a']);
  expect(response.body.data.map((med: any) => [med.id, med.total_stock, med.medicine_batches.map((b: any) => b.id)]))
    .toEqual([['med-a', 7, ['a-1', 'a-2']]]);
});
