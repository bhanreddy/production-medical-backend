import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { supabaseAdmin } from '../config/supabase';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { auditLog } from '../services/auditLog';
import { AppError } from '../lib/appError';

export const whatsappRouter = Router();

const broadcastBodySchema = z.object({
  template_name: z.string().min(1),
  customer_filter: z.object({
    segment: z.enum(['all', 'high_value', 'at_risk', 'lost']),
    last_purchase_days: z.number().optional(),
  }),
  template_params: z.array(z.string()).default([]),
});

const broadcastLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cid = (req as any).user?.clinic_id;
    return cid ? `broadcast:${cid}` : req.ip || 'unknown';
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        message: 'Maximum one broadcast per 24 hours per clinic.',
        code: 'BROADCAST_RATE_LIMIT',
      },
    });
  },
});

whatsappRouter.post(
  '/broadcast',
  requireAuth,
  requireRole('OWNER'),
  broadcastLimiter,
  async (req, res, next) => {
    try {
      const clinicId = req.user!.clinic_id!;
      const parsed = broadcastBodySchema.parse(req.body);

      const { data: sub } = await supabaseAdmin
        .from('clinic_subscriptions')
        .select('plan_name, status')
        .eq('clinic_id', clinicId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const plan = sub?.plan_name || 'trial';
      if (!['pro', 'custom'].includes(plan)) {
        throw new AppError(402, 'Bulk WhatsApp broadcast requires Pro plan.', 'PRO_PLAN_REQUIRED');
      }

      let q = supabaseAdmin.from('customers').select('id, phone, name, importance_score, last_purchase_date').eq('clinic_id', clinicId).not('phone', 'is', null);

      const now = new Date();
      if (parsed.customer_filter.segment === 'high_value') {
        q = q.gte('importance_score', 80);
      } else if (parsed.customer_filter.segment === 'at_risk') {
        const from = new Date(now);
        from.setDate(from.getDate() - 60);
        const to = new Date(now);
        to.setDate(to.getDate() - 31);
        q = q.lte('last_purchase_date', to.toISOString().split('T')[0]).gte('last_purchase_date', from.toISOString().split('T')[0]);
      } else if (parsed.customer_filter.segment === 'lost') {
        const cut = new Date(now);
        cut.setDate(cut.getDate() - 61);
        q = q.or(`last_purchase_date.lt.${cut.toISOString().split('T')[0]},last_purchase_date.is.null`);
      }

      const { data: customers, error } = await q;
      if (error) throw error;
      const list = (customers || []).filter((c) => c.phone);

      const batchSize = 10;
      const delayMs = 1000;
      let queued = 0;
      for (let i = 0; i < list.length; i += batchSize) {
        const chunk = list.slice(i, i + batchSize);
        await Promise.all(
          chunk.map((c) =>
            sendWhatsAppMessage({
              phoneNumber: String(c.phone),
              templateName: parsed.template_name,
              templateParams: parsed.template_params.length
                ? parsed.template_params
                : [c.name || 'Customer'],
            })
          )
        );
        queued += chunk.length;
        if (i + batchSize < list.length) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      await supabaseAdmin.from('whatsapp_broadcast_log').insert({
        clinic_id: clinicId,
        template_name: parsed.template_name,
        recipient_count: queued,
      });

      await auditLog({
        clinicId,
        userId: req.user!.id,
        action: 'WHATSAPP_BROADCAST',
        table: 'customers',
        newData: { template: parsed.template_name, queued },
      });

      const minutes = Math.ceil((queued / batchSize) * (delayMs / 60000)) || 1;
      res.json({ queued, estimated_completion_minutes: minutes });
    } catch (err) {
      next(err);
    }
  }
);
