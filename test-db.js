const postgres = require('postgres');

const sql = postgres({
  host: 'aws-1-ap-south-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  username: 'postgres.mlbdrcdsalbrpcwyidqw',
  password: 'Dengeyr@p00ka',
  ssl: 'require',
  connect_timeout: 15,
});

async function main() {
  try {
    console.log("\n=== RLS Policies on shortbook ===");
    const policies = await sql`
      SELECT * 
      FROM pg_policies 
      WHERE tablename = 'shortbook'
    `;
    console.log(policies);

    console.log("\n=== Table definitions of shortbook ===");
    const tblDef = await sql`
      SELECT column_name, column_default, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'shortbook'
    `;
    console.log(tblDef);

  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
