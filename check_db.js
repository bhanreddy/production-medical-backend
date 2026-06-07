const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres');

async function main() {
  const meds = await sql`SELECT id, name, is_active, deleted_at FROM medicines LIMIT 5`;
  console.log('Meds:', meds);
  process.exit(0);
}
main().catch(console.error);
