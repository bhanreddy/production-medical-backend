import postgres from 'postgres';

// Importing a mocked route in unit tests must not require a live database or
// silently load production credentials from .env. Real SQL tests opt in explicitly.
const connectionString = process.env.DATABASE_URL || (process.env.NODE_ENV === 'test'
  ? 'postgres://127.0.0.1:1/medical_unconfigured_qa'
  : undefined);
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Transaction mode (port 6543) cannot reuse a prepared statement, so every query pays an extra round trip.
// The session pooler on 5432 accepts the same credentials and keeps the statement for the next sale.
let connectionUrl = connectionString;
let prepare = true;
try {
  const url = new URL(connectionString);
  if (url.port === '6543') url.port = '5432';
  connectionUrl = url.toString();
} catch {
  prepare = !connectionString.includes(':6543');
}

const sql = postgres(connectionUrl, {
  max: 4,
  // Reopening a pooler connection costs several network round trips; keep idle ones between POS actions.
  idle_timeout: 300,
  connect_timeout: 10,
  prepare,
  fetch_types: false,
});

export default sql;
