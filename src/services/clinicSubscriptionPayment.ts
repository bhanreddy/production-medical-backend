import type { SupabaseClient } from '@supabase/supabase-js';

export function amountPaiseForClinicPlan(
  plan: { price_monthly: number | string; price_annual: number | string },
  billingCycle: 'monthly' | 'annual'
): number {
  const inr =
    billingCycle === 'annual' ? Number(plan.price_annual) : Number(plan.price_monthly);
  return Math.round(inr * 100);
}

export function computeClinicBillingPeriodEndIso(billingCycle: string): { startIso: string; endIso: string } {
  const start = new Date();
  const end = new Date(start);
  if (billingCycle === 'annual') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

type ClinicSubRow = {
  id: string;
  clinic_id: string;
  plan_name: string;
  billing_cycle: string;
};

export async function finalizeClinicPhonePePayment(
  admin: SupabaseClient,
  row: ClinicSubRow,
  merchantOrderId: string,
  transactionId: string,
  providerOrderId: string | null,
  amountInr: number
): Promise<{ alreadyDone: boolean }> {
  const { data: existing } = await admin
    .from('clinic_subscriptions')
    .select('id, status')
    .eq('id', row.id)
    .single();

  if (existing?.status === 'active') {
    return { alreadyDone: true };
  }

  const { startIso, endIso } = computeClinicBillingPeriodEndIso(row.billing_cycle);

  const { error: updErr } = await admin
    .from('clinic_subscriptions')
    .update({
      status: 'active',
      current_period_start: startIso,
      current_period_end: endIso,
      payment_provider_order_id: providerOrderId,
    })
    .eq('id', row.id);

  if (updErr) throw updErr;

  const { data: invDup } = await admin
    .from('subscription_invoices')
    .select('id')
    .eq('razorpay_payment_id', transactionId)
    .maybeSingle();

  if (!invDup) {
    const { error: invErr } = await admin.from('subscription_invoices').insert({
      clinic_id: row.clinic_id,
      subscription_id: row.id,
      razorpay_invoice_id: merchantOrderId,
      razorpay_payment_id: transactionId,
      amount: amountInr,
      status: 'paid',
      paid_at: new Date().toISOString(),
    });
    if (invErr) throw invErr;
  }

  return { alreadyDone: false };
}
