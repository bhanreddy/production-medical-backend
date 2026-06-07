import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { validateV1Headers } from '../middleware/requireV1Context';
import { getV1 } from '../types';
import {
  applyPushRecord,
  completeSyncSession,
  getSyncStatus,
  pullChanges,
  startSyncSession,
} from './syncService';

export const v1SyncRouter = Router();

const pushBodySchema = z.object({
  sessionId: z.string().uuid(),
  deviceId: z.string().min(1),
  records: z.array(
    z.object({
      table: z.string(),
      localId: z.string(),
      remoteId: z.string().uuid().nullable().optional(),
      operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
      version: z.number().int().min(1).default(1),
      payload: z.record(z.unknown()).default({}),
      localCreatedAt: z.string().optional(),
      localUpdatedAt: z.string().optional(),
    })
  ),
});

v1SyncRouter.post('/session/start', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const { lastSyncAt, clientVersion } = req.body || {};
    const session = await startSyncSession(v1.clinicId, v1.deviceId, lastSyncAt, clientVersion || v1.clientVersion);
    res.json(session);
  } catch (e) {
    next(e);
  }
});

v1SyncRouter.post('/session/complete', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const body = z
      .object({
        sessionId: z.string().uuid(),
        recordsPushed: z.number().int().min(0),
        recordsPulled: z.number().int().min(0),
        conflicts: z.number().int().min(0).optional(),
      })
      .parse(req.body);
    const out = await completeSyncSession(body.sessionId, v1.clinicId, body);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

v1SyncRouter.post('/push', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const body = pushBodySchema.parse(req.body);
    if (body.deviceId !== v1.deviceId) {
      return res.status(400).json({ error: 'deviceId mismatch' });
    }
    const results = [];
    for (const rec of body.records) {
      const r = await applyPushRecord(v1.clinicId, v1.deviceId, {
        table: rec.table,
        localId: rec.localId,
        remoteId: rec.remoteId ?? null,
        operation: rec.operation,
        version: rec.version,
        payload: rec.payload as Record<string, unknown>,
      });
      results.push(r);
    }
    res.json({
      sessionId: body.sessionId,
      results,
      pushedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

v1SyncRouter.get('/pull', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const since = (req.query.since as string) || 'never';
    const tables = (req.query.tables as string) || 'medicines,customers,suppliers,invoices,purchases,expenses';
    const limit = parseInt(String(req.query.limit || '500'), 10);
    const out = await pullChanges(v1.clinicId, v1.deviceId, since, tables, limit);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

v1SyncRouter.get('/status', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const out = await getSyncStatus(v1.clinicId, v1.deviceId);
    res.json(out);
  } catch (e) {
    next(e);
  }
});
