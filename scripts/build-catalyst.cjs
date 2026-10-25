const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.catalyst-build');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('npm', ['run', 'build']);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.cpSync(path.join(root, 'dist'), path.join(output, 'dist'), { recursive: true, filter: file => !file.includes('__tests__') });
fs.cpSync(path.join(root, 'migrations'), path.join(output, 'migrations'), { recursive: true });
// Build Linux AMD64 dependencies without executing a foreign binary on macOS.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--os=linux', '--cpu=x64', '--no-audit', '--no-fund'], output);
run(process.execPath, [path.join(output, 'node_modules/prebuild-install/bin.js'), '--platform=linux', '--arch=x64', '--target=24.14.1', '--runtime=node'], path.join(output, 'node_modules/better-sqlite3'));
const native = fs.readFileSync(path.join(output, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
if (native.readUInt32BE(0) !== 0x7f454c46 || native.readUInt16LE(18) !== 62) throw new Error('Expected a Linux x86-64 SQLite binary');
const dotenv = require('dotenv');
const source = { ...dotenv.parse(fs.readFileSync(path.join(root, process.env.CATALYST_ENV_FILE || '.env'))), ...process.env };
const keys = [
  'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET',
  'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ALLOWED_ORIGINS', 'ANTHROPIC_API_KEY', 'CRON_SECRET', 'LOG_LEVEL', 'SENTRY_DSN',
  'WHATSAPP_API_KEY', 'WHATSAPP_PHONE_NUMBER_ID', 'APP_URL', 'PHONEPE_ENV', 'PHONEPE_CLIENT_ID', 'PHONEPE_CLIENT_SECRET',
  'PHONEPE_CLIENT_VERSION', 'PHONEPE_MERCHANT_ID', 'PHONEPE_CLINIC_REDIRECT_URL', 'PHONEPE_WEBHOOK_USERNAME', 'PHONEPE_WEBHOOK_PASSWORD',
  'SCHOOL_OPS_SUPABASE_URL', 'SCHOOL_OPS_SUPABASE_ANON_KEY', 'SCHOOL_OPS_SUPABASE_SERVICE_ROLE_KEY',
];
for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ALLOWED_ORIGINS']) {
  if (!source[key]?.trim()) throw new Error(`Missing required runtime setting: ${key}`);
}
const variables = Object.fromEntries(keys.filter(key => source[key]?.trim()).map(key => [key, source[key]]));
Object.assign(variables, { NODE_ENV: 'production', DURABLE_RUNTIME: 'postgres', DURABLE_RUNTIME_KEY: 'medical-pos', LOCAL_DB_PATH: ':memory:' });
// AppSail sends this configuration separately and excludes app-config.json from the code archive.
fs.writeFileSync(path.join(output, 'app-config.json'), JSON.stringify({
  command: 'node dist/server.js', build_path: '.', stack: 'node24', memory: 512,
  catalyst_auth: false, env_variables: variables,
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(output, '.catalystignore'), '**/.env*\n**/*.db*\n**/.git/**\n**/__tests__/**\n');
console.log('Catalyst bundle ready: Linux x86-64, Node 24, production dependencies, durable PostgreSQL state.');
