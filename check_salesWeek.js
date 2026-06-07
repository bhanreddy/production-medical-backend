const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const clinicId = 'c1000000-0000-0000-0000-000000000001';
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekStr = weekAgo.toISOString();

  console.log('weekStr:', weekStr);
  const salesWeek = await sql.unsafe(
    `SELECT net_amount, created_at FROM sales WHERE clinic_id = $1 AND deleted_at IS NULL AND is_return=false AND created_at>=$2`,
    [clinicId, weekStr]
  );
  console.log('salesWeek:', salesWeek);
  process.exit(0);
}
main().catch(console.error);
