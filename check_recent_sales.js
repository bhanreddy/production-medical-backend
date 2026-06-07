const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const clinicId = 'c1000000-0000-0000-0000-000000000001';
  const recentSalesRaw = await sql.unsafe(
    `SELECT s.id, s.invoice_number, s.net_amount, s.created_at, c.name as customer_name
     FROM sales s
     LEFT JOIN customers c ON s.customer_id = c.id
     WHERE s.clinic_id = $1 AND s.deleted_at IS NULL AND s.is_return = false
     ORDER BY s.created_at DESC
     LIMIT 10`,
    [clinicId]
  );
  console.log('recentSalesRaw:', recentSalesRaw);
  process.exit(0);
}
main().catch(console.error);
