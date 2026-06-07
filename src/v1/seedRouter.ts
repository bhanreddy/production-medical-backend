import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validateV1Headers } from './middleware/requireV1Context';
import { getV1 } from './types';
import { seedFullPage } from './sync/syncService';

export const v1SeedRouter = Router();

v1SeedRouter.get('/full', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = parseInt(String(req.query.limit || '500'), 10);
    const data = await seedFullPage(v1.clinicId, page, limit);
    res.json(data);
  } catch (e) {
    next(e);
  }
});
