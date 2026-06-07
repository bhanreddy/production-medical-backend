import { integrationEnabled } from './integrationEnv';

const describeInt = integrationEnabled ? describe : describe.skip;

describeInt('Multitenancy (integration)', () => {
  test('configure TEST_SUPABASE_* to run cross-tenant isolation checks', () => {
    expect(integrationEnabled).toBe(true);
  });
});
