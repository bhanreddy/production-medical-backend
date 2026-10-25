import { loadSaleReferences } from '../../services/saleReferences';
import { queryRaw } from '../../lib/postgresDb';

jest.mock('../../lib/postgresDb', () => ({ queryRaw: jest.fn() }));
const raw = jest.mocked(queryRaw);

beforeEach(() => raw.mockReset());

test('loads a 20-line cart in two clinic-scoped reads and resolves both ID formats', async () => {
  raw.mockResolvedValueOnce([{ id: 'med-cloud', _local_id: 'med-local' }])
    .mockResolvedValueOnce([{ id: 'batch-cloud', _local_id: 'batch-local', quantity_remaining: 30 }]);
  const items = Array.from({ length: 20 }, () => ({ medicine_id: 'med-local', batch_id: 'batch-local' }));
  const result = await loadSaleReferences(items, 'clinic-a');
  expect(raw).toHaveBeenCalledTimes(2);
  expect(raw.mock.calls[0][1]).toEqual(['clinic-a', 'med-local', 'med-local']);
  expect(raw.mock.calls[1][1]).toEqual(['clinic-a', 'batch-local', 'batch-local']);
  for (const [query] of raw.mock.calls) {
    expect(query).toContain('clinic_id = ? AND deleted_at IS NULL');
  }
  expect(result.medicines.get('med-cloud')).toBe(result.medicines.get('med-local'));
  expect(result.batches.get('batch-local').quantity_remaining).toBe(30);
});

test('leaves missing references absent for the existing checkout validation', async () => {
  raw.mockResolvedValue([]);
  const result = await loadSaleReferences([{ medicine_id: 'missing', batch_id: 'missing' }], 'clinic-a');
  expect(result.medicines.has('missing')).toBe(false);
  expect(result.batches.has('missing')).toBe(false);
});
