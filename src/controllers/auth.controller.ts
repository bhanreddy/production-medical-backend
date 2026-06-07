import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../config/supabase';

// Helper to generate tokens
const generateTokens = (user: any, clinic_id: string, plan: string) => {
  const payload = {
    sub: user.id,
    clinic_id,
    role: user.role,
    plan
  };
  // Fallback to a default secret if not set, but in production it should throw
  const secret = process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod';
  const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
  
  const accessToken = jwt.sign(payload, secret, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, refreshSecret, { expiresIn: '30d' });
  
  return { accessToken, refreshToken };
};

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, clinic_name } = req.body;
    if (!email || !password || !name || !clinic_name) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create Clinic
    const { data: clinic, error: clinicErr } = await supabaseAdmin
      .from('clinics')
      .insert({ name: clinic_name, plan: 'trial' })
      .select()
      .single();

    if (clinicErr || !clinic) {
      return res.status(500).json({ success: false, error: 'Failed to create clinic' });
    }

    // Create User
    const { data: user, error: userErr } = await supabaseAdmin
      .from('clinic_users')
      .insert({
        clinic_id: clinic.id,
        email,
        password: hashedPassword,
        name,
        role: 'owner'
      })
      .select()
      .single();

    if (userErr || !user) {
      // Rollback clinic if user creation fails
      await supabaseAdmin.from('clinics').delete().eq('id', clinic.id);
      return res.status(500).json({ success: false, error: 'Failed to create user' });
    }

    const { accessToken, refreshToken } = generateTokens(user, clinic.id, clinic.plan);

    res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 });

    return res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        clinic: { id: clinic.id, name: clinic.name, plan: clinic.plan },
        accessToken
      }
    });

  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // 1. Verify credentials via a temporary Supabase Auth client to avoid mutating the global supabaseAdmin singleton
    const tempClient = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const { data: authData, error: authError } = await tempClient.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError || !authData.user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const supabaseUser = authData.user;

    // 2. Look up user details from our users table

    const { data: userRowResult, error: userQueryError } = await supabaseAdmin
      .from('users')
      .select('id, clinic_id, role, full_name, phone')
      .eq('id', supabaseUser.id)
      .single();

    if (userQueryError && userQueryError.code !== 'PGRST116') {
      console.error('[login] User query database error:', userQueryError);
    }

    let userRow = userRowResult;

    // 2b. Auto-provision if user exists in Supabase Auth but not in users table
    if (!userRow) {
      const meta = supabaseUser.user_metadata || {};
      const shopName = meta.shop_name || meta.clinic_name || email.split('@')[0] + "'s Clinic";

      // Check for existing clinic by email
      const { data: existingClinic, error: existingClinicErr } = await supabaseAdmin
        .from('clinics')
        .select('id, name, plan')
        .eq('email', email.trim())
        .single();

      if (existingClinicErr && existingClinicErr.code !== 'PGRST116') {
        console.error('[login] Existing clinic lookup error:', existingClinicErr);
      }

      let clinicId: string;

      if (existingClinic) {
        clinicId = existingClinic.id;
      } else {
        const baseSlug = shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || 'clinic';
        const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;

        const { data: newClinic, error: clinicErr } = await supabaseAdmin
          .from('clinics')
          .insert({ name: shopName, email: email.trim(), plan: 'trial', slug })
          .select('id, name, plan')
          .single();

        if (clinicErr || !newClinic) {
          console.error('[login] Failed to create clinic during auto-provisioning:', clinicErr);
          return res.status(500).json({ success: false, error: 'Failed to set up account. Please try again.', details: clinicErr?.message });
        }
        clinicId = newClinic.id;
      }

      // Create user row
      const { data: newUser, error: userErr } = await supabaseAdmin
        .from('users')
        .upsert({
          id: supabaseUser.id,
          clinic_id: clinicId,
          full_name: meta.full_name || email.split('@')[0],
          role: 'OWNER',
        }, { onConflict: 'id' })
        .select('id, clinic_id, role, full_name, phone')
        .single();

      if (userErr || !newUser) {
        console.error('[login] Failed to create user row during auto-provisioning:', userErr);
        return res.status(500).json({ success: false, error: 'Failed to set up account. Please try again.', details: userErr?.message });
      }

      userRow = newUser;
      console.log(`[login] Auto-provisioned user ${supabaseUser.email} in clinic ${clinicId}`);
    }

    // 3. Fetch clinic details
    const { data: clinic } = await supabaseAdmin
      .from('clinics')
      .select('id, name, plan')
      .eq('id', userRow.clinic_id)
      .single();

    const plan = clinic?.plan || 'trial';

    // 4. Issue custom JWTs
    const tokenUser = { id: userRow.id, role: userRow.role };
    const { accessToken, refreshToken } = generateTokens(tokenUser, userRow.clinic_id, plan);
    
    res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: userRow.id,
          email: supabaseUser.email || email,
          name: userRow.full_name || email.split('@')[0],
          role: userRow.role,
        },
        clinic: clinic ? { id: clinic.id, name: clinic.name, plan: clinic.plan } : undefined,
        accessToken,
        refreshToken
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const refresh = async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;
  
  if (!refreshToken) {
    return res.status(401).json({ success: false, error: 'No refresh token' });
  }

  try {
    const refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod';
    const payload = jwt.verify(refreshToken, refreshSecret) as any;
    
    // Check if user still exists
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, role')
      .eq('id', payload.sub)
      .single();

    if (!user) {
      return res.status(401).json({ success: false, error: 'User no longer exists' });
    }

    const secret = process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod';
    const newRefreshSecret = process.env.JWT_REFRESH_SECRET || secret;

    const newAccessToken = jwt.sign({
      sub: payload.sub,
      clinic_id: payload.clinic_id,
      role: payload.role,
      plan: payload.plan
    }, secret, { expiresIn: '15m' });

    // Rotate the refresh token as well
    const newRefreshToken = jwt.sign({
      sub: payload.sub,
      clinic_id: payload.clinic_id,
      role: payload.role,
      plan: payload.plan
    }, newRefreshSecret, { expiresIn: '30d' });

    res.cookie('refreshToken', newRefreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 });

    return res.status(200).json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      }
    });
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
};
