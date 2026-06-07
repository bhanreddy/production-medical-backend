import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
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
    // Get current subscription + plan limits
    const { data: sub } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('status, trial_end, plan_name')
      .eq('clinic_id', clinic_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let limits: any = getDefaultLimits('trial');
    let subStatus = 'trial';
    let trialEnd = null;

    if (!sub) {
      // No subscription row > treat as trial via defaults
      (req as any).planLimits = limits;
    } else {
      subStatus = sub.status;
      trialEnd = sub.trial_end;

      const { data: plan } = await supabaseAdmin
        .from('subscription_plans')
        .select('limits')
        .eq('name', sub.plan_name)
        .single();

      if (plan && plan.limits) {
        limits = plan.limits;
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
    const pathNoQuery = (req.originalUrl || '').split('?')[0];
    const isCreateSalePost = req.method === 'POST' && /\/api\/sales\/?$/.test(pathNoQuery);

    if (isCreateSalePost) {
      const today = new Date().toISOString().split('T')[0];
      const { count } = await supabaseAdmin
        .from('sales')
        .select('*', { count: 'exact', head: true })
        .eq('clinic_id', clinic_id)
        .gte('sale_date', today)
        .eq('is_return', false);

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
