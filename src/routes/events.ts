import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { addClient, removeClient } from '../lib/sseManager';

export const eventsRouter = Router();

/**
 * GET /api/events/stream
 *
 * Server-Sent Events endpoint for real-time updates.
 *
 * Authentication:
 *   - Mobile: Authorization header (Bearer token)
 *   - Desktop (browser EventSource): ?token= query param
 *     (EventSource does not support custom headers)
 *
 * Clients receive events like:
 *   data: {"type":"EXPENSE_ADDED","payload":{...}}
 */
eventsRouter.get('/stream', async (req: Request, res: Response) => {
  // ─── Auth: Accept token from header (mobile) OR query param (desktop) ──
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : null;
  const queryToken = req.query.token as string | undefined;
  const token = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  // Verify token via Supabase
  const { data: { user: supabaseUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !supabaseUser) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Look up clinic_id from users table
  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('clinic_id')
    .eq('id', supabaseUser.id)
    .single();

  const clinicId = userRow?.clinic_id;
  if (!clinicId) {
    return res.status(403).json({ error: 'User not associated with a clinic' });
  }

  // ─── SSE Headers ──────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx compatibility
  res.flushHeaders();

  // Send an initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', payload: { clinicId } })}\n\n`);

  // ─── Heartbeat every 30s to keep connection alive ─────
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  // ─── Register this client ─────────────────────────────
  addClient(clinicId, res);

  // ─── Cleanup on disconnect ────────────────────────────
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(clinicId, res);
  });
});

export default eventsRouter;
