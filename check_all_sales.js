const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const sales = await sql`SELECT id, invoice_number, is_return, deleted_at, created_at FROM sales`;
  console.log('Total sales:', sales.length);
  sales.forEach(s => console.log(s));
  process.exit(0);
}
main().catch(console.error);
