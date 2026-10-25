import { Request, Response, NextFunction } from 'express';
import { queryRaw } from '../lib/postgresDb';
import { env } from '../config/env';

// Attach default limits mimicking 'trial' if no row exists
const getDefaultLimits = (plan: string) => {
  return plan === 'trial' 
    ? { max_users: 1, max_daily_bills: 25, trial_days: 14 }
    : { max_users: 2, max_daily_bills: 100 };
};

export const enforcePlan = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !req.user.clinic_id) return next();

  const clinic_id = req.user.clinic_id;

  try {
    const pathNoQuery = (req.originalUrl || '').split('?')[0];
    const isCreateSalePost = req.method === 'POST' && /\/api\/sales\/?$/.test(pathNoQuery);
    const today = new Date().toISOString().split('T')[0];
    // The sale already uses PostgreSQL. Read current limits and usage together
    // instead of making three sequential HTTP calls back to the same database.
    const [snapshot] = await queryRaw(
      `WITH current_subscription AS (
         SELECT status, trial_end, plan_name FROM clinic_subscriptions
         WHERE clinic_id = ? ORDER BY created_at DESC LIMIT 1
       )
       SELECT sub.status, sub.trial_end, plan.limits,
         ${isCreateSalePost ? '(SELECT COUNT(*)::int FROM sales WHERE clinic_id = ? AND sale_date >= ? AND is_return = false)' : 'NULL'} AS bill_count
       FROM (SELECT 1) seed
       LEFT JOIN current_subscription sub ON true
       LEFT JOIN subscription_plans plan ON plan.name = sub.plan_name`,
      isCreateSalePost ? [clinic_id, clinic_id, today] : [clinic_id],
    );
    const sub = snapshot?.status ? snapshot : null;

    let limits: any = getDefaultLimits('trial');
    let subStatus = 'trial';
    let trialEnd = null;

    if (!sub) {
      // No subscription row > treat as trial via defaults
      (req as any).planLimits = limits;
    } else {
      subStatus = sub.status;
      trialEnd = sub.trial_end;

      if (sub.limits) {
        limits = sub.limits;
      }
      (req as any).planLimits = limits;
    }

    // Trial expired (status = trial, but date passed)
    if (subStatus === 'trial' && trialEnd && new Date(trialEnd) < new Date()) {
      return res.status(402).json({
        error: {
          message: 'Trial expired. Please subscribe to continue.',
          code: 'TRIAL_EXPIRED',
          upgrade_url: `${env.APP_URL}/settings/billing`,
        },
      });
    }

    // Subscription inactive
    if (['expired', 'halted', 'cancelled'].includes(subStatus)) {
      return res.status(402).json({
        error: {
          message: 'Subscription inactive. Please renew to continue.',
          code: 'SUBSCRIPTION_INACTIVE',
          upgrade_url: `${env.APP_URL}/settings/billing`,
        },
      });
    }

    // Enforce POST /api/sales (not /returns) max daily limits — use full URL because mounted routers see path as '/'
    if (isCreateSalePost) {
      const count = snapshot?.bill_count;

      if (count !== null && count >= (limits.max_daily_bills || 25)) {
        return res.status(402).json({
          error: {
            message: `Daily billing limit of ${limits.max_daily_bills} reached. Upgrade your plan.`,
            code: 'DAILY_LIMIT_REACHED',
            upgrade_url: `${env.APP_URL}/settings/billing`,
          },
        });
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};
