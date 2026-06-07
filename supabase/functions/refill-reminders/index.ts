import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { supabaseAdmin } from '../_shared/supabase.ts'
import { sendPushNotifications } from '../_shared/pushNotification.ts'

serve(async (req: Request) => {
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const today = new Date().toISOString().split('T')[0]

    // 1. Get all unsent reminders due today or overdue
    const { data: reminders } = await supabaseAdmin
      .from('refill_reminders')
      .select(`
        id,
        clinic_id,
        remind_on,
        customers ( id, name, phone ),
        medicines ( name )
      `)
      .lte('remind_on', today)
      .eq('is_sent', false)

    if (!reminders?.length) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 })
    }

    // 2. Group reminders by clinic
    const byClinic = reminders.reduce((acc: any, r: any) => {
      if (!acc[r.clinic_id]) acc[r.clinic_id] = []
      acc[r.clinic_id].push(r)
      return acc
    }, {})

    const allMessages: any[] = []
    const sentIds: string[] = []

    for (const [clinicId, clinicReminders] of Object.entries(byClinic)) {
      // 3. Get device tokens for this clinic
      const { data: tokens } = await supabaseAdmin
        .from('device_tokens')
        .select('expo_push_token')
        .eq('clinic_id', clinicId)
        .eq('is_active', true)

      if (!tokens?.length) continue

      const pushTokens = tokens.map((t: any) => t.expo_push_token)

      // 4. Group by customer (one notification per customer, list all medicines)
      const byCustomer = (clinicReminders as any[]).reduce((acc: any, r: any) => {
        const custId = r.customers?.id
        if (!custId) return acc
        if (!acc[custId]) acc[custId] = { customer: r.customers, medicines: [], ids: [] }
        acc[custId].medicines.push(r.medicines?.name)
        acc[custId].ids.push(r.id)
        return acc
      }, {})

      for (const [, { customer, medicines, ids }] of Object.entries(byCustomer) as any) {
        const medList = medicines.slice(0, 3).join(', ') +
          (medicines.length > 3 ? ` +${medicines.length - 3} more` : '')

        pushTokens.forEach((token: string) => {
          allMessages.push({
            to: token,
            title: `💊 Refill Reminder — ${customer.name}`,
            body: `Time to refill: ${medList}`,
            data: {
              type: 'refill',
              clinic_id: clinicId,
              customer_id: customer.id,
            },
            channelId: 'reminders',
            priority: 'default',
          })
        })
        sentIds.push(...ids)
      }
    }

    // 5. Send notifications
    if (allMessages.length > 0) {
      await sendPushNotifications(allMessages)
    }

    // --- PHASE 6 : WHATSAPP REFILL REMINDERS ---
    const whatsappApiKey = Deno.env.get('WHATSAPP_API_KEY');
    if (whatsappApiKey) {
      for (const [clinicId, clinicReminders] of Object.entries(byClinic)) {
        // Fetch clinic info for template
        const { data: clinic } = await supabaseAdmin.from('clinics').select('name, phone').eq('id', clinicId).single();
        if (!clinic) continue;

        const byCustomer = (clinicReminders as any[]).reduce((acc: any, r: any) => {
          const custId = r.customers?.id
          if (!custId) return acc
          if (!acc[custId]) acc[custId] = { customer: r.customers, medicines: [], ids: [] }
          acc[custId].medicines.push(r.medicines?.name)
          acc[custId].ids.push(r.id)
          return acc
        }, {})

        for (const [, { customer, medicines }] of Object.entries(byCustomer) as any) {
          if (customer.phone) {
            const medList = medicines.slice(0, 3).join(', ') +
              (medicines.length > 3 ? ` +${medicines.length - 3} more` : '')
            
            try {
              await fetch('https://api.interakt.ai/v1/public/message/', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${whatsappApiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  countryCode: '+91',
                  phoneNumber: customer.phone.replace(/^91/, '').replace(/^\+91/, ''),
                  callbackData: 'medpos_notification',
                  type: 'Template',
                  template: {
                    name: 'refill_reminder',
                    languageCode: 'en',
                    bodyValues: [
                      customer.name,
                      medList,
                      clinic.name,
                      clinic.phone || ''
                    ]
                  }
                })
              });
              // Throttle
              await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
              console.error('WhatsApp dispatch failed', err);
            }
          }
        }
      }
    }

    // 6. Mark reminders as sent
    if (sentIds.length > 0) {
      await supabaseAdmin
        .from('refill_reminders')
        .update({ is_sent: true, sent_at: new Date().toISOString() })
        .in('id', sentIds)
    }

    return new Response(
      JSON.stringify({ sent: allMessages.length, reminders_processed: sentIds.length }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('refill-reminders error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
