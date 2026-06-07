import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';

export const adminRouter = Router();

// Gated by SUPER_ADMIN role
adminRouter.use(requireAuth);
adminRouter.use(requireRole(['SUPER_ADMIN']));

adminRouter.get('/stats', async (req, res, next) => {
  try {
    const [{ count: total_clinics }, { count: active_clinics }, { count: trial_clinics }, { count: paid_clinics }, { count: total_users }] = await Promise.all([
      supabaseAdmin.from('clinics').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('clinics').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabaseAdmin.from('clinics').select('*', { count: 'exact', head: true }).eq('plan', 'trial'),
      supabaseAdmin.from('clinics').select('*', { count: 'exact', head: true }).in('plan', ['basic', 'pro']),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true })
    ]);

    res.json({
      total_clinics,
      active_clinics,
      trial_clinics,
      paid_clinics,
      total_users,
      // Just sending mock/0 for the ones needing complex cross-clinic time queries for now, can be updated later
      active_users_today: 0,
      total_sales_today: 0,
      total_sales_this_month: 0,
      new_clinics_this_month: 0,
      churn_this_month: 0,
      top_clinics_by_revenue: [],
      plan_distribution: [
        { plan: 'trial', count: trial_clinics },
        { plan: 'basic', count: 0 },
        { plan: 'pro', count: 0 }
      ]
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/clinics', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('clinics').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/clinics/:medical_id', async (req, res, next) => {
  try {
    const { medical_id } = req.params;
    const { data: clinic, error } = await supabaseAdmin.from('clinics').select('*').eq('id', medical_id).single();
    if (error) throw error;
    res.json({ data: clinic });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/clinics/:medical_id/profile', async (req, res, next) => {
  try {
    const { medical_id } = req.params;
    const { data: clinic, error } = await supabaseAdmin.from('clinics').select('*').eq('id', medical_id).single();
    if (error) throw error;
    res.json({ data: clinic });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/clinics/:medical_id/profile', async (req, res, next) => {
  try {
    const { medical_id } = req.params;
    const { name, owner_name, address, phone, email, gstin, drug_licence_number, logo_url, signature_url, invoice_footer } = req.body;
    
    const payload = {
      name, owner_name, address, phone, email, gstin, drug_licence_number, logo_url, signature_url, invoice_footer
    };
    
    // Remove undefined
    Object.keys(payload).forEach(key => payload[key as keyof typeof payload] === undefined && delete payload[key as keyof typeof payload]);

    const { data, error } = await supabaseAdmin
      .from('clinics')
      .update(payload)
      .eq('id', medical_id)
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin.from('audit_logs').insert([{ 
      action: 'UPDATE_PROFILE', 
      table_name: 'clinics', 
      record_id: medical_id, 
      new_data: payload, 
      clinic_id: medical_id, 
      user_id: req.user?.id 
    }]);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/clinics/:id/plan', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plan } = req.body;
    const { data, error } = await supabaseAdmin.from('clinics').update({ plan }).eq('id', id).select().single();
    if (error) throw error;
    
    await supabaseAdmin.from('audit_logs').insert([{ action: 'UPDATE', table_name: 'clinics', record_id: id, new_data: { plan }, clinic_id: id, user_id: req.user?.id }]);
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/clinics/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const { data, error } = await supabaseAdmin.from('clinics').update({ is_active }).eq('id', id).select().single();
    if (error) throw error;
    
    await supabaseAdmin.from('audit_logs').insert([{ action: 'UPDATE', table_name: 'clinics', record_id: id, new_data: { is_active }, clinic_id: id, user_id: req.user?.id }]);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('users').select('*, clinics(name)').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/audit', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('audit_logs').select('*, users(full_name), clinics(name)').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/medicines/master/import', async (req, res, next) => {
  try {
    const csv = req.body?.csv;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ error: { message: 'Body must include csv string' } });
    }

    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    const rows = records
      .map((r) => ({
        name: r.name || r.Name || '',
        generic_name: r.generic_name || r.generic || null,
        manufacturer: r.manufacturer || null,
        category: r.category || null,
        hsn_code: r.hsn_code || r.hsn || null,
        gst_rate: r.gst_rate ? Number(r.gst_rate) : 0,
        schedule: r.schedule || null,
        barcode: r.barcode || null,
        unit: r.unit || 'strip',
        is_active: true,
      }))
      .filter((row) => row.name.length > 0);

    if (!rows.length) {
      return res.status(400).json({ error: { message: 'No valid rows in CSV' } });
    }

    const { data, error } = await supabaseAdmin.from('medicine_master').insert(rows).select('id');
    if (error) throw error;

    const { data: firstClinic } = await supabaseAdmin.from('clinics').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (firstClinic?.id) {
      await supabaseAdmin.from('audit_logs').insert({
        action: 'MASTER_IMPORT',
        table_name: 'medicine_master',
        clinic_id: firstClinic.id,
        user_id: req.user?.id || null,
        new_data: { inserted: data?.length || rows.length },
      });
    }

    res.status(201).json({ inserted: data?.length || rows.length });
  } catch (err) {
    next(err);
  }
});
