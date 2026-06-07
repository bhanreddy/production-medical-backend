import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'connected';
  let dbLatencyMs = 0;

  try {
    await supabaseAdmin.from('clinics').select('id').limit(1);
    dbLatencyMs = Date.now() - start;
  } catch {
    dbStatus = 'disconnected';
    dbLatencyMs = -1;
  }

  const mem = process.memoryUsage();

  res.json({
    status: dbStatus === 'connected' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime_seconds: Math.floor(process.uptime()),
    db: {
      status: dbStatus,
      latency_ms: dbLatencyMs,
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

