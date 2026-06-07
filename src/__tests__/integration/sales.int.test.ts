import { integrationEnabled } from './integrationEnv';

const describeInt = integrationEnabled ? describe : describe.skip;

describeInt('POST /api/sales (integration)', () => {
  test('configure TEST_SUPABASE_URL and seed clinics/users to run supertest suite', () => {
    expect(integrationEnabled).toBe(true);
  });
});
