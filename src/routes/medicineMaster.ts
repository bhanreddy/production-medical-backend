import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';

const medicineMasterRouter = Router();

medicineMasterRouter.get('/master/search', requireAuth, async (req, res, next) => {
  try {
    const q = (req.query.q as string) || '';
    if (!q || q.length < 2) {
      return res.json({ data: [] });
    }

    const { data, error } = await supabaseAdmin
      .from('medicine_master')
      .select('name, generic_name, manufacturer, hsn_code, gst_rate, schedule, barcode, category, unit')
      .eq('is_active', true)
      .or(`name.ilike.%${q}%,generic_name.ilike.%${q}%`)
      .limit(50);

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    next(err);
  }
});

medicineMasterRouter.get('/master/barcode/:barcode', requireAuth, async (req, res, next) => {
  try {
    const barcode = req.params.barcode;
    const { data, error } = await supabaseAdmin
      .from('medicine_master')
      .select('name, generic_name, manufacturer, hsn_code, gst_rate, schedule, barcode, category, unit')
      .eq('is_active', true)
      .eq('barcode', barcode)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: { message: 'Master record not found', code: 'NOT_FOUND' } });
    }
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export default medicineMasterRouter;
