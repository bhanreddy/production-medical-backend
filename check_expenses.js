const postgres = require('postgres');
const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr@p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require');

async function main() {
  try {
    const clinics = await sql`SELECT id, name FROM clinics`;
    console.log('Clinics:', clinics);
  } catch (e) {
    console.error('Clinics error:', e.message);
  }

  try {
    const clinicUsers = await sql`SELECT id, email, clinic_id, role, name FROM clinic_users`;
    console.log('Clinic Users:', clinicUsers);
  } catch (e) {
    console.error('Clinic Users error:', e.message);
  }

  try {
    const users = await sql`SELECT * FROM users`;
    console.log('Users:', users);
  } catch (e) {
    console.error('Users error:', e.message);
  }

  try {
    const expenses = await sql`SELECT * FROM expenses`;
    console.log('Expenses:', expenses);
  } catch (e) {
    console.error('Expenses error:', e.message);
  }
  process.exit(0);
}
main().catch(console.error);
