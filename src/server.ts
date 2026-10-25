import 'dotenv/config';
import './instrument';
import { createApp } from './app';
import { printServerReady } from './lib/consoleStyle';
import sql from './db';
import { runPendingMigrations } from './lib/runMigrations';
import { logger } from './lib/logger';

// Default 5001: macOS often binds 5000 to AirPlay Receiver, which returns 403 to random HTTP and blocks the API.
const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 5001;

async function start() {
  if (process.env.X_ZOHO_CATALYST_LISTEN_PORT && process.env.DURABLE_RUNTIME !== 'postgres') {
    throw new Error('Catalyst requires DURABLE_RUNTIME=postgres to protect embedded workflow data');
  }
  let ready = false;
  const app = createApp();
  // Bind immediately for AppSail cold starts, but reject traffic until initialization succeeds.
  const express = await import('express');
  const gateway = express.default();
  gateway.use((_req, res, next) => ready ? next() : res.status(503).json({ status: 'starting' }));
  gateway.use(app);
  const server = gateway.listen(PORT, () => printServerReady(Number(PORT)));
  try {
    await runPendingMigrations();
  } catch (err) {
    logger.error('Startup migrations failed', { err });
    server.close();
    await sql.end();
    process.exitCode = 1;
    return;
  }

  // Open the pool before accepting traffic. A new pooler connection costs more than the query itself.
  try {
    await Promise.all([sql`SELECT 1`, sql`SELECT 1`]);
  } catch (err) {
    logger.error('Database connection warmup failed', { err });
  }

  ready = true;
}

start().catch(error => { logger.error('Server startup failed', { message: error.message }); process.exitCode = 1; });
