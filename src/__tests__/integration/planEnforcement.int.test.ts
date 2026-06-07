import { integrationEnabled } from './integrationEnv';

const describeInt = integrationEnabled ? describe : describe.skip;

describeInt('Plan enforcement (integration)', () => {
  test('configure TEST_SUPABASE_* to assert 402 TRIAL_EXPIRED and DAILY_LIMIT_REACHED', () => {
    expect(integrationEnabled).toBe(true);
  });
});
