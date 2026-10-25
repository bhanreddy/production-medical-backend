import { enforcePlan } from '../../middleware/planEnforcement';
import { queryRaw } from '../../lib/postgresDb';
jest.mock('../../lib/postgresDb', () => ({ queryRaw: jest.fn() }));
const read = jest.mocked(queryRaw);
const req = (path = '/api/sales') => ({ user: { clinic_id: 'clinic-a' }, method: 'POST', originalUrl: path } as any);
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any);
beforeEach(() => read.mockReset());

test('checks current subscription, plan and usage in one database query', async () => {
  read.mockResolvedValue([{ status: 'active', limits: { max_daily_bills: 100 }, bill_count: 99 }]);
  const next = jest.fn();
  await enforcePlan(req(), res(), next);
  expect(next).toHaveBeenCalledWith();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][1]).toEqual(['clinic-a', 'clinic-a', expect.any(String)]);
});
test.each([
  [{ status: 'trial', trial_end: '2000-01-01', bill_count: 0 }, 'TRIAL_EXPIRED'],
  [{ status: 'cancelled', bill_count: 0 }, 'SUBSCRIPTION_INACTIVE'],
  [{ status: null, bill_count: 25 }, 'DAILY_LIMIT_REACHED'],
  [{ status: 'active', limits: { max_daily_bills: 100 }, bill_count: 100 }, 'DAILY_LIMIT_REACHED'],
])('preserves billing restrictions for %j', async (snapshot, code) => {
  read.mockResolvedValue([snapshot]);
  const response = res(), next = jest.fn();
  await enforcePlan(req(), response, next);
  expect(response.status).toHaveBeenCalledWith(402);
  expect(response.json.mock.calls[0][0].error.code).toBe(code);
  expect(next).not.toHaveBeenCalled();
});
test('does not count bills for returns, and database outages never bypass the check', async () => {
  read.mockRejectedValue(new Error('Database unavailable'));
  const next = jest.fn();
  await enforcePlan(req('/api/sales/returns'), res(), next);
  expect(read.mock.calls[0][1]).toEqual(['clinic-a']);
  expect(next).toHaveBeenCalledWith(expect.any(Error));
});
