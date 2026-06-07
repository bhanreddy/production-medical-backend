const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const sales = await sql`SELECT id, clinic_id, invoice_number, is_return, deleted_at, created_at FROM sales LIMIT 5`;
  console.log('Sales:', sales);
  process.exit(0);
}
main().catch(console.error);
