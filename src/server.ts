import 'dotenv/config';
import './instrument';
import { createApp } from './app';
import { printServerReady } from './lib/consoleStyle';
import sql from './db';
import { runPendingMigrations } from './lib/runMigrations';
import { logger } from './lib/logger';

// Default 5001: macOS often binds 5000 to AirPlay Receiver, which returns 403 to random HTTP and blocks the API.
const PORT = process.env.PORT || 5001;

async function start() {
  try {
    await runPendingMigrations();
  } catch (err) {
    logger.error('Startup migrations failed — API may be degraded', { err });
  }

  // Open the pool before accepting traffic. A new pooler connection costs more than the query itself.
  try {
    await Promise.all([sql`SELECT 1`, sql`SELECT 1`]);
  } catch (err) {
    logger.error('Database connection warmup failed', { err });
  }

  const app = createApp();
  app.listen(PORT, () => {
    printServerReady(Number(PORT));
  });
}

start();
