const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  const users = await sql`SELECT id, email, clinic_id FROM users`;
  console.log('Users:', users);
  process.exit(0);
}
main().catch(console.error);
