import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
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
eventsRouter.get('/stream', (req: Request, _res: Response, next: NextFunction) => {
  if (!req.headers.authorization && typeof req.query.token === 'string') req.headers.authorization = `Bearer ${req.query.token}`;
  next();
}, requireAuth, (req: Request, res: Response) => {
  const clinicId = req.user?.clinic_id;
  if (!clinicId) return res.status(403).json({ error: 'Choose a pharmacy to receive live updates' });

  if (res.destroyed || res.writableEnded) return;

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
  res.on('close', () => {
    clearInterval(heartbeat);
    removeClient(clinicId, res);
  });
});

export default eventsRouter;
