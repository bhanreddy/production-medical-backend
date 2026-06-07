const postgres = require('postgres');
const fs = require('fs');
const path = require('path');

const CLINIC_ID = 'c1000000-0000-0000-0000-000000000001';
const USER_ID = '37ad8e02-2675-4cf1-b4d6-9f7e395b5fa8';
const EMAIL = '25e001.nexsyrus@gmail.com';

async function main() {
  const sql = postgres('postgresql://postgres.mlbdrcdsalbrpcwyidqw:Dengeyr%40p00ka@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require', {
    connect_timeout: 30,
  });

  try {
    console.log('Connected to database...');

    console.log('\n--- Step 1: Running schema.sql ---');
    let schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    schema = schema.replace(/CREATE EXTENSION IF NOT EXISTS "pg_cron".*?;/g, '-- pg_cron skipped');
    
    // Run the whole thing at once
    try {
      await sql.unsafe(schema);
      console.log('  Schema applied successfully');
    } catch (e) {
      console.error('  Schema Error:', e.message);
      // If it fails, maybe some tables already exist. We'll continue anyway.
    }

    // Step 2: Create clinic
    console.log('\n--- Step 2: Creating clinic ---');
    await sql`
      INSERT INTO clinics (id, name, slug, address, phone, email, gstin, drug_licence_number, plan, is_active)
      VALUES (${CLINIC_ID}, 'Medical Shop 1', 'medical-shop-1', '3/2 Ashanpally maddur, Telangana 509407', '9347556547', ${EMAIL}, '123BAN123CB', '123456897654', 'trial', true)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;
    console.log('  Clinic created');

    // Step 3: Create user row
    console.log('\n--- Step 3: Creating user ---');
    await sql`
      INSERT INTO users (id, clinic_id, full_name, phone, role, is_active)
      VALUES (${USER_ID}, ${CLINIC_ID}, 'Default', '9347556547', 'OWNER', true)
      ON CONFLICT (id) DO UPDATE SET clinic_id = EXCLUDED.clinic_id, role = 'OWNER'
    `;
    console.log('  User created');

    // Step 4: Create trial subscription
    console.log('\n--- Step 4: Creating trial subscription ---');
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    await sql`
      INSERT INTO clinic_subscriptions (clinic_id, plan_name, status, billing_cycle, trial_end)
      VALUES (${CLINIC_ID}, 'trial', 'trial', 'monthly', ${trialEnd})
      ON CONFLICT DO NOTHING
    `;
    console.log('  Trial subscription created');

    // Step 5: Set medical_profile verified = true
    console.log('\n--- Step 5: Setting medical_profile verified ---');
    await sql`UPDATE medical_profile SET verified = true WHERE id = ${USER_ID}`;
    console.log('  medical_profile verified = true');

    console.log('\nProvisioning complete!');
  } catch (e) {
    console.error('Fatal:', e.message);
  } finally {
    await sql.end();
  }
}

main();
