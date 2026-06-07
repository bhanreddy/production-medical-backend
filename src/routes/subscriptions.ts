import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import {
  makeClinicMerchantOrderId,
  phonePeCreateCheckoutPay,
  phonePeFetchOrderStatus,
  verifyPhonePeWebhookAuthorization,
} from '../payment/phonePePG';
import {
  amountPaiseForClinicPlan,
  finalizeClinicPhonePePayment,
} from '../services/clinicSubscriptionPayment';

export const subscriptionsRouter = Router();

// GET /api/subscriptions/plans
subscriptionsRouter.get('/plans', async (req, res, next) => {
  try {
    const { data: plans, error } = await supabaseAdmin
      .from('subscription_plans')
      .select('*')
      .eq('is_active', true)
      .order('price_monthly', { ascending: true });

    if (error) throw error;
    res.json({ data: plans });
  } catch (err) {
    next(err);
  }
});

// GET /api/subscriptions/current
subscriptionsRouter.get('/current', requireAuth, async (req, res, next) => {
  try {
    const { data: sub, error } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('*')
      .eq('clinic_id', req.user!.clinic_id!)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    const { data: plan } = sub
      ? await supabaseAdmin.from('subscription_plans').select('*').eq('name', sub.plan_name).single()
      : { data: null };

    res.json({ data: { subscription: sub, plan } });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/create — PhonePe Standard Checkout (one-shot plan payment)
subscriptionsRouter.post('/create', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { plan_name, billing_cycle = 'monthly' } = req.body;
    const cycle = billing_cycle === 'annual' ? 'annual' : 'monthly';

    const redirectUrl = env.PHONEPE_CLINIC_REDIRECT_URL?.trim();
    if (!redirectUrl) {
      return res.status(503).json({
        error: { message: 'PHONEPE_CLINIC_REDIRECT_URL is not configured on the server' },
      });
    }

    const { data: plan, error: planErr } = await supabaseAdmin
      .from('subscription_plans')
      .select('*')
      .eq('name', plan_name)
      .single();

    if (planErr || !plan) {
      return res.status(400).json({ error: { message: 'Invalid plan selected' } });
    }

    const amountPaise = amountPaiseForClinicPlan(plan, cycle);
    if (!amountPaise || amountPaise <= 0) {
      return res.status(400).json({ error: { message: 'Plan has no payable amount for this billing cycle' } });
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('clinic_subscriptions')
      .insert({
        clinic_id: req.user!.clinic_id!,
        plan_name,
        status: 'pending',
        billing_cycle: cycle,
      })
      .select('id')
      .single();

    if (insErr || !inserted) {
      return res.status(500).json({ error: { message: insErr?.message || 'Failed to create subscription' } });
    }

    const merchantOrderId = makeClinicMerchantOrderId(inserted.id);

    const { error: updErr } = await supabaseAdmin
      .from('clinic_subscriptions')
      .update({ payment_merchant_order_id: merchantOrderId })
      .eq('id', inserted.id);

    if (updErr) {
      await supabaseAdmin.from('clinic_subscriptions').delete().eq('id', inserted.id);
      return res.status(500).json({ error: { message: updErr.message } });
    }

    const payBody = {
      merchantOrderId,
      amount: amountPaise,
      expireAfter: 1800,
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: `MedPOS clinic ${plan_name} (${cycle})`,
        merchantUrls: {
          redirectUrl,
        },
      },
      metaInfo: {
        udf1: inserted.id,
        udf2: req.user!.clinic_id!,
        udf3: plan_name,
        udf4: cycle,
      },
    };

    let payJson: { orderId?: string; redirectUrl?: string; message?: string; code?: string };
    try {
      const { ok, data } = await phonePeCreateCheckoutPay(payBody);
      payJson = data;
      if (!ok || !data.redirectUrl || !data.orderId) {
        await supabaseAdmin.from('clinic_subscriptions').delete().eq('id', inserted.id);
        return res.status(502).json({
          error: { message: data.message || data.code || 'PhonePe checkout could not be started' },
        });
      }
    } catch (e) {
      await supabaseAdmin.from('clinic_subscriptions').delete().eq('id', inserted.id);
      throw e;
    }

    await supabaseAdmin
      .from('clinic_subscriptions')
      .update({ payment_provider_order_id: payJson.orderId! })
      .eq('id', inserted.id);

    res.json({
      data: {
        subscription_id: inserted.id,
        redirect_url: payJson.redirectUrl,
        merchant_order_id: merchantOrderId,
        phonepe_order_id: payJson.orderId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/verify-payment — after PhonePe redirect (client calls with merchant_order_id)
subscriptionsRouter.post('/verify-payment', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const merchantOrderId = (req.body?.merchant_order_id as string | undefined)?.trim();
    if (!merchantOrderId) {
      return res.status(400).json({ error: { message: 'merchant_order_id is required' } });
    }

    const { data: row, error: selErr } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('id, clinic_id, plan_name, billing_cycle, status, payment_merchant_order_id')
      .eq('payment_merchant_order_id', merchantOrderId)
      .eq('clinic_id', req.user!.clinic_id!)
      .maybeSingle();

    if (selErr || !row) {
      return res.status(404).json({ error: { message: 'Subscription order not found' } });
    }

    if (row.status === 'active') {
      const { data: full } = await supabaseAdmin
        .from('clinic_subscriptions')
        .select('current_period_end')
        .eq('id', row.id)
        .single();
      return res.json({
        data: {
          ok: true,
          subscription_id: row.id,
          current_period_end: full?.current_period_end ?? null,
          plan_name: row.plan_name,
          already_active: true,
        },
      });
    }

    const { ok, data: st } = await phonePeFetchOrderStatus(merchantOrderId);
    if (!ok) {
      return res.status(502).json({
        error: { message: st.message || st.code || 'PhonePe order status request failed' },
      });
    }

    if (st.state !== 'COMPLETED') {
      return res.status(409).json({
        error: {
          message: `Payment not completed (order state: ${st.state ?? 'unknown'})`,
          order_state: st.state ?? null,
        },
      });
    }

    const latest = st.paymentDetails?.filter((p) => p.state === 'COMPLETED').pop();
    const txId = latest?.transactionId ?? st.orderId ?? merchantOrderId;

    const { data: plan } = await supabaseAdmin
      .from('subscription_plans')
      .select('price_monthly, price_annual')
      .eq('name', row.plan_name)
      .single();

    const amountInr = plan
      ? amountPaiseForClinicPlan(plan, row.billing_cycle === 'annual' ? 'annual' : 'monthly') / 100
      : 0;

    await finalizeClinicPhonePePayment(
      supabaseAdmin,
      {
        id: row.id,
        clinic_id: row.clinic_id,
        plan_name: row.plan_name,
        billing_cycle: row.billing_cycle,
      },
      merchantOrderId,
      txId,
      st.orderId ?? null,
      amountInr
    );

    const { data: after } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('current_period_end')
      .eq('id', row.id)
      .single();

    res.json({
      data: {
        ok: true,
        subscription_id: row.id,
        current_period_end: after?.current_period_end ?? null,
        plan_name: row.plan_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/subscriptions/invoices
subscriptionsRouter.get('/invoices', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const { data: invoices, error } = await supabaseAdmin
      .from('subscription_invoices')
      .select('*')
      .eq('clinic_id', req.user!.clinic_id!)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ data: invoices });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/cancel — local cancellation (PhonePe checkout is not a recurring mandate)
subscriptionsRouter.post('/cancel', requireAuth, requireRole('OWNER'), async (req, res, next) => {
  try {
    const subscription_id = req.body?.subscription_id as string | undefined;
    if (!subscription_id) {
      return res.status(400).json({ error: { message: 'subscription_id is required' } });
    }

    const { data: sub } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('*')
      .eq('id', subscription_id)
      .eq('clinic_id', req.user!.clinic_id!)
      .single();

    if (!sub) return res.status(404).json({ error: { message: 'Subscription not found' } });

    if (sub.status === 'pending') {
      await supabaseAdmin.from('clinic_subscriptions').delete().eq('id', sub.id);
      return res.json({ data: { message: 'Pending checkout cancelled' } });
    }

    if (sub.status !== 'active') {
      return res.status(400).json({ error: { message: 'Only active subscriptions can be cancelled this way' } });
    }

    await supabaseAdmin
      .from('clinic_subscriptions')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', sub.id);

    res.json({ data: { message: 'Subscription cancelled' } });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/webhook — PhonePe (checkout.order.completed)
subscriptionsRouter.post('/webhook', async (req, res, next) => {
  try {
    const authHeader = (req.headers.authorization ?? '').trim();
    if (!verifyPhonePeWebhookAuthorization(authHeader)) {
      return res.status(401).json({ error: 'Invalid webhook authorization' });
    }

    const payload = req.body as {
      event?: string;
      payload?: {
        state?: string;
        merchantOrderId?: string;
        orderId?: string;
        paymentDetails?: Array<{ state?: string; transactionId?: string }>;
      };
    };

    const event = payload.event ?? '';
    if (event !== 'checkout.order.completed') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const p = payload.payload;
    if (!p || p.state !== 'COMPLETED' || !p.merchantOrderId) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    const { data: row, error: selErr } = await supabaseAdmin
      .from('clinic_subscriptions')
      .select('id, clinic_id, plan_name, billing_cycle, status, payment_merchant_order_id')
      .eq('payment_merchant_order_id', p.merchantOrderId)
      .maybeSingle();

    if (selErr || !row) {
      return res.status(200).json({ ok: true, note: 'no subscription row' });
    }

    if (row.status === 'active') {
      return res.status(200).json({ ok: true, idempotent: true });
    }

    const latest = p.paymentDetails?.filter((x) => x.state === 'COMPLETED').pop();
    const txId = latest?.transactionId ?? p.orderId ?? p.merchantOrderId;

    const { data: plan } = await supabaseAdmin
      .from('subscription_plans')
      .select('price_monthly, price_annual')
      .eq('name', row.plan_name)
      .single();

    const amountInr = plan
      ? amountPaiseForClinicPlan(plan, row.billing_cycle === 'annual' ? 'annual' : 'monthly') / 100
      : 0;

    await finalizeClinicPhonePePayment(
      supabaseAdmin,
      {
        id: row.id,
        clinic_id: row.clinic_id,
        plan_name: row.plan_name,
        billing_cycle: row.billing_cycle,
      },
      p.merchantOrderId,
      txId,
      p.orderId ?? null,
      amountInr
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('PhonePe Webhook Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
