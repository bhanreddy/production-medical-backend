const queryRaw = jest.fn();
jest.mock('../lib/postgresDb', () => ({ queryRaw: (...args: unknown[]) => queryRaw(...args) }));
jest.mock('../config/supabase', () => ({ supabaseAdmin: { from: jest.fn(), auth: { getUser: jest.fn() } } }));
import { getUserProfile, resetSupabaseIdentityCache } from '../lib/supabaseIdentity';

const originalDatabaseUrl = process.env.DATABASE_URL;
afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test('a configured database pool answers the profile and the second request reuses it', async () => {
  process.env.DATABASE_URL = 'postgres://pooler.example/postgres';
  resetSupabaseIdentityCache();
  queryRaw.mockResolvedValueOnce([{ clinic_id: 'clinic-a', role: 'OWNER', full_name: 'Owner' }]);
  const first = await getUserProfile('user-1');
  const second = await getUserProfile('user-1');
  expect(first.data).toEqual({ clinic_id: 'clinic-a', role: 'OWNER', full_name: 'Owner' });
  expect(second.data?.role).toBe('OWNER');
  expect(queryRaw).toHaveBeenCalledTimes(1);
  expect(queryRaw.mock.calls[0][0]).toContain('FROM users');
  expect(queryRaw.mock.calls[0][1]).toEqual(['user-1']);
});

test('a missing profile stays a not-found result and a database failure stays retryable', async () => {
  process.env.DATABASE_URL = 'postgres://pooler.example/postgres';
  resetSupabaseIdentityCache();
  queryRaw.mockResolvedValueOnce([]);
  expect((await getUserProfile('missing')).error?.code).toBe('PGRST116');
  resetSupabaseIdentityCache();
  queryRaw.mockRejectedValueOnce(new Error('connection reset'));
  expect((await getUserProfile('missing')).error?.code).toBe('NETWORK_ERROR');
});
