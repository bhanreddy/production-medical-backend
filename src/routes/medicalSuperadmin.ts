import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { verifySuperAdminSchoolMiddleware } from '../middleware/verifySuperAdminSchool';

const router = Router();

const ensureMedicalProject = (_req: Request, res: Response, next: NextFunction) => {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    return res.status(503).json({
      success: false,
      error: 'Medical Supabase client is not configured on the server. Please check environment variables.',
    });
  }
  next();
};

/**
 * @route   GET /api/v1/medical/shops
 * @desc    Get all medical shops (medical_profile)
 */
router.get('/shops', verifySuperAdminSchoolMiddleware, ensureMedicalProject, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('medical_profile')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('Failed to fetch medical shops', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   POST /api/v1/medical/shops
 * @desc    Create medical shop + auth user on medical Supabase project
 */
router.post('/shops', verifySuperAdminSchoolMiddleware, ensureMedicalProject, async (req: Request, res: Response) => {
  try {
    const {
      medical_name,
      owner_name,
      email,
      password,
      gst_number,
      drug_license_number,
      address_line_1,
      address_line_2,
      city,
      state,
      pincode,
      phone_number,
      logo_url,
    } = req.body;

    if (
      !medical_name ||
      !owner_name ||
      !email ||
      !password ||
      !gst_number ||
      !drug_license_number ||
      !address_line_1 ||
      !city ||
      !state ||
      !pincode ||
      !phone_number
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: owner_name,
      },
    });

    if (authError) {
      throw new Error(`Failed to create auth user: ${authError.message}`);
    }

    const userId = authData.user.id;

    const { data, error } = await supabaseAdmin
      .from('medical_profile')
      .insert([
        {
          user_id: userId,
          email,
          medical_name,
          owner_name,
          gst_number,
          drug_license_number,
          address_line_1,
          address_line_2,
          city,
          state,
          pincode,
          phone_number,
          logo_url,
        },
      ])
      .select()
      .single();

    if (error) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      throw new Error(`Failed to insert profile: ${error.message}`);
    }

    res.status(201).json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('Failed to create medical shop', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export const medicalSuperadminRouter = router;
