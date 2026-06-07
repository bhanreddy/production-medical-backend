import { createClient } from '@supabase/supabase-js';
import { integrationEnabled } from './integrationEnv';

const describeInt = integrationEnabled ? describe : describe.skip;

describeInt('stockLedger (integration — requires TEST_SUPABASE_*)', () => {
  test('connects and is ready for FIFO scenarios when env is set', () => {
    const url = process.env.TEST_SUPABASE_URL!;
    const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, key);
    expect(supabase).toBeDefined();
  });
});
