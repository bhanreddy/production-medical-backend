import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';

export const v1HealthRouter = Router();

v1HealthRouter.get('/health', async (_req, res) => {
  const t0 = Date.now();
  try {
    const { error } = await supabaseAdmin.from('clinics').select('id').limit(1);
    const dbLatency = Date.now() - t0;
    if (error) {
      return res.status(503).json({ status: 'degraded', serverTime: new Date().toISOString(), dbLatency });
    }
    res.json({ status: 'ok', serverTime: new Date().toISOString(), dbLatency });
  } catch {
    res.status(503).json({ status: 'degraded', serverTime: new Date().toISOString(), dbLatency: Date.now() - t0 });
  }
});
