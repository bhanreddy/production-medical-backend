const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const cols = await sql`
    SELECT column_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'sales' AND column_name = 'is_return'
  `;
  console.log(cols);
  process.exit(0);
}
main().catch(console.error);
