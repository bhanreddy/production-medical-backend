// Initialize only a disposable localhost *_qa database. Never reads production credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const url = new URL(process.env.TEST_DATABASE_URL || 'http://missing.invalid');
if (!['localhost','127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_qa')) throw new Error('Set TEST_DATABASE_URL to a disposable localhost database ending in _qa.');
Object.assign(process.env, {
  DATABASE_URL: url.href, NODE_ENV: 'test', LOCAL_DB_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(),'medical-setup-qa-')),'runtime.db'),
  SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key', SUPABASE_JWT_SECRET: 'test-jwt-secret', ALLOWED_ORIGINS: 'http://localhost:8082',
});
const sql = require('../dist/db').default;
(async()=>{
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY)');
  await sql.unsafe(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
  await require('../dist/lib/runMigrations').runPendingMigrations();
  console.log('QA database initialized with the canonical schema and all migrations.');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>sql.end());
