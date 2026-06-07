import { SupabaseClient } from '@supabase/supabase-js';

export async function scheduleRefillReminders(
  saleId: string,
  clinicId: string,
  supabase: SupabaseClient
): Promise<void> {
  try {
    const { data: sale } = await supabase
      .from('sales')
      .select('customer_id')
      .eq('id', saleId)
      .eq('clinic_id', clinicId)
      .single();

    if (!sale || !sale.customer_id) return;
    const customerId = sale.customer_id;

    const { data: saleItems } = await supabase
      .from('sale_items')
      .select('medicine_id')
      .eq('sale_id', saleId)
      .eq('clinic_id', clinicId);

    if (!saleItems) return;

    for (const item of saleItems) {
      // Find all past sales for this medicine by this customer
      const { data: history } = await supabase
        .from('sale_items')
        .select(`
          sale_id,
          sales!inner(sale_date, customer_id)
        `)
        .eq('clinic_id', clinicId)
        .eq('medicine_id', item.medicine_id)
        .eq('sales.customer_id', customerId);

      if (!history || history.length < 2) continue;

      // Extract sorted dates
      const dates = history.map((h: any) => new Date(h.sales.sale_date).getTime()).sort((a, b) => a - b);
      
      let totalDiff = 0;
      let diffCount = 0;

      for (let i = 1; i < dates.length; i++) {
        const diffMs = dates[i] - dates[i - 1];
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays > 0) {
          totalDiff += diffDays;
          diffCount++;
        }
      }

      if (diffCount > 0) {
        const avgDays = Math.ceil(totalDiff / diffCount);
        const remindOn = new Date();
        remindOn.setDate(remindOn.getDate() + avgDays);
        const remindOnDateStr = remindOn.toISOString().split('T')[0];

        // Upsert reminder
        // Check if exists
        const { data: existing } = await supabase
          .from('refill_reminders')
          .select('id')
          .eq('clinic_id', clinicId)
          .eq('customer_id', customerId)
          .eq('medicine_id', item.medicine_id)
          .single();

        if (existing) {
          await supabase.from('refill_reminders')
            .update({ remind_on: remindOnDateStr, is_sent: false })
            .eq('id', existing.id);
        } else {
          await supabase.from('refill_reminders')
            .insert({
              clinic_id: clinicId,
              customer_id: customerId,
              medicine_id: item.medicine_id,
              remind_on: remindOnDateStr,
            });
        }
      }
    }
  } catch (err) {
    console.error('scheduleRefillReminders error:', err);
  }
}
