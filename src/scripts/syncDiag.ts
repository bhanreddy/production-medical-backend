/**
 * Run the offline-first migration directly via Supabase Management API.
 * Uses the service_role key to execute SQL.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mlbdrcdsalbrpcwyidqw.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1sYmRyY2RzYWxicnBjd3lpZHF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDAzMzE5OSwiZXhwIjoyMDg1NjA5MTk5fQ.JXm6nUw6oMVFedHpnZF3Zv5CjC_3t_dratYu_eEqvnM';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  db: { schema: 'public' },
});

const TABLES = [
  'suppliers', 'customers', 'medicines', 'medicine_batches',
  'purchases', 'purchase_items', 'sales', 'sale_items',
  'expenses',
];

async function runMigration() {
  console.log('=== Running Supabase Offline-First Migration ===\n');

  // Step 1: Create the exec_sql helper function first
  const createFnSql = `
    CREATE OR REPLACE FUNCTION exec_sql(sql TEXT) RETURNS void AS $$
    BEGIN
      EXECUTE sql;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `;
  
  const { error: fnErr } = await supabase.rpc('exec_sql', { sql: createFnSql });
  
  // If exec_sql doesn't exist yet, we need another way. Let's try via REST.
  if (fnErr) {
    console.log('exec_sql RPC not available. Creating it via direct SQL endpoint...');
    
    // Use Supabase HTTP endpoint for SQL (Dashboard API)
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ sql: createFnSql }),
    });
    
    if (!resp.ok) {
      console.log('Direct approach also failed. Using pg library...');
    }
  }
  
  // Use pg library directly
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: 'postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false },
  });
  
  const client = await pool.connect();
  
  try {
    for (const table of TABLES) {
      console.log(`\nMigrating: ${table}`);
      
      // Add _local_id
      try {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS _local_id TEXT UNIQUE`);
        console.log(`  ✓ _local_id added`);
      } catch (e: any) {
        console.log(`  ✗ _local_id: ${e.message}`);
      }
      
      // Add updated_at
      try {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`);
        console.log(`  ✓ updated_at added`);
      } catch (e: any) {
        console.log(`  ✗ updated_at: ${e.message}`);
      }
      
      // Add deleted_at
      try {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
        console.log(`  ✓ deleted_at added`);
      } catch (e: any) {
        console.log(`  ✗ deleted_at: ${e.message}`);
      }
    }
    
    // Create updated_at trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('\n✓ Trigger function created');
    
    // Apply trigger to all tables
    for (const table of TABLES) {
      try {
        await client.query(`
          DROP TRIGGER IF EXISTS trg_set_updated_at ON "${table}";
          CREATE TRIGGER trg_set_updated_at
            BEFORE UPDATE ON "${table}"
            FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
        `);
        console.log(`✓ Trigger applied to ${table}`);
      } catch (e: any) {
        console.log(`✗ Trigger on ${table}: ${e.message}`);
      }
    }
    
    // Notify PostgREST to refresh schema cache
    await client.query('NOTIFY pgrst, \'reload schema\'');
    console.log('\n✓ Schema cache refresh requested');
    
  } finally {
    client.release();
    await pool.end();
  }
  
  console.log('\n=== Migration complete ===');
  
  // Verify
  console.log('\n=== Verification ===');
  const { data, error } = await supabase
    .from('medicines')
    .insert({
      _local_id: 'verify-test-001',
      clinic_id: 'c1000000-0000-0000-0000-000000000001',
      name: 'VERIFY_TEST',
    })
    .select('id, _local_id, updated_at, deleted_at')
    .single();
    
  if (error) {
    console.log('Verification FAILED:', error.message);
    console.log('Hint: Wait a few seconds for PostgREST schema cache to refresh, then try again.');
  } else {
    console.log('Verification PASSED! New columns present:', JSON.stringify(data));
    await supabase.from('medicines').delete().eq('_local_id', 'verify-test-001');
    console.log('Cleaned up test record.');
  }
}

runMigration().catch(console.error);
