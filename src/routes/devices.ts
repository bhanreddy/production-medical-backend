import { localMutate, queryAll, queryOne, queryRaw, queryCount } from '../lib/postgresDb';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';


export const devicesRouter = Router();

devicesRouter.post('/register', requireAuth, async (req: any, res, next) => {
  try {
    const { expo_push_token, platform } = req.body;
    
    if (!expo_push_token || !platform) {
      return res.status(400).json({ error: 'Missing token or platform' });
    }

    await localMutate({
      table: 'device_tokens',
      operation: 'INSERT',
      data: {
        clinic_id: req.user.clinic_id,
        user_id: req.user.id,
        expo_push_token,
        platform,
        is_active: true
      }
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

devicesRouter.delete('/unregister', requireAuth, async (req: any, res, next) => {
  try {
    const { expo_push_token } = req.body;
    
    if (!expo_push_token) {
      return res.status(400).json({ error: 'Missing token' });
    }

    await localMutate({
      table: 'device_tokens',
      operation: 'DELETE',
      data: { _local_id: `${req.user.id}:${expo_push_token}` }
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
