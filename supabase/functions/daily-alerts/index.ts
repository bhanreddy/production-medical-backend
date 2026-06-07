import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { supabaseAdmin } from '../_shared/supabase.ts'
import { sendPushNotifications } from '../_shared/pushNotification.ts'

serve(async (req: Request) => {
  // Verify this is called from Supabase scheduler (not a random HTTP request)
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    // 1. Get all active clinics
    const { data: clinics } = await supabaseAdmin
      .from('clinics')
      .select('id, name')
      .eq('is_active', true)

    if (!clinics?.length) return new Response('No active clinics', { status: 200 })

    const allMessages: any[] = []

    for (const clinic of clinics) {
      // 2. Get all active device tokens for this clinic
      const { data: tokens } = await supabaseAdmin
        .from('device_tokens')
        .select('expo_push_token, user_id')
        .eq('clinic_id', clinic.id)
        .eq('is_active', true)

      if (!tokens?.length) continue

      const pushTokens = tokens.map((t: any) => t.expo_push_token)

      // 3. Low stock count
      const { count: lowStockCount } = await supabaseAdmin
        .from('low_stock_alerts')
        .select('*', { count: 'exact', head: true })
        .eq('clinic_id', clinic.id)

      // 4. Critical expiry count (≤30 days)
      const thirtyDaysOut = new Date()
      thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30)
      const { count: expiryCount } = await supabaseAdmin
        .from('medicine_batches')
        .select('*', { count: 'exact', head: true })
        .eq('clinic_id', clinic.id)
        .lte('expiry_date', thirtyDaysOut.toISOString().split('T')[0])
        .gte('expiry_date', new Date().toISOString().split('T')[0])
        .gt('quantity_remaining', 0)

      // 5. Build and push low stock alert
      if (lowStockCount && lowStockCount > 0) {
        pushTokens.forEach(token => {
          allMessages.push({
            to: token,
            title: '⚠️ Low Stock Alert',
            body: `${lowStockCount} medicine${lowStockCount > 1 ? 's are' : ' is'} running low in your pharmacy`,
            data: { type: 'low_stock', clinic_id: clinic.id },
            channelId: 'alerts',
            priority: 'high',
            badge: (lowStockCount || 0) + (expiryCount || 0),
          })
        })
      }

      // 6. Build and push expiry alert
      if (expiryCount && expiryCount > 0) {
        pushTokens.forEach(token => {
          allMessages.push({
            to: token,
            title: '🔴 Expiry Alert',
            body: `${expiryCount} batch${expiryCount > 1 ? 'es' : ''} expiring within 30 days`,
            data: { type: 'expiry', clinic_id: clinic.id },
            channelId: 'alerts',
            priority: 'high',
          })
        })
      }
    }

    // 7. Send all notifications in batches
    if (allMessages.length > 0) {
      await sendPushNotifications(allMessages)
    }

    return new Response(
      JSON.stringify({ sent: allMessages.length, clinics: clinics.length }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('daily-alerts error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
