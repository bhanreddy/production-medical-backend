import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sql from '../db';
import { AppError } from '../lib/appError';
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
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new AppError(503, 'Authentication is not configured. Contact support.');
  const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
  
  const accessToken = jwt.sign({ ...payload, token_use: 'access' }, secret, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ ...payload, token_use: 'refresh' }, refreshSecret, { expiresIn: '30d' });
  
  return { accessToken, refreshToken };
};

const registrationSchema = z.object({
  email: z.string().trim().email().max(254), password: z.string().min(8).max(128),
  full_name: z.string().trim().min(2).max(200), clinic_name: z.string().trim().min(3).max(200),
  phone: z.string().regex(/^[6-9]\d{9}$/),
  slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/).optional(),
  gstin: z.string().length(15).optional().or(z.literal('')),
  drug_licence_number: z.string().max(100).optional(),
});

export const register = async (req: Request, res: Response) => {
  const parsed = registrationSchema.safeParse({ ...req.body, full_name: req.body?.full_name || req.body?.name });
  if (!parsed.success) return res.status(400).json({ error: 'Please check your registration details.', details: parsed.error.flatten().fieldErrors });
  const input = parsed.data;
  let authUserId: string | undefined;
  try {
    const existing = await sql`SELECT id FROM users WHERE LOWER(email) = LOWER(${input.email}) AND deleted_at IS NULL LIMIT 1`;
    if (existing.length) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    // Use a separate client: signing up must never replace the server's service-role session.
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.auth.signUp({ email: input.email, password: input.password,
      options: { data: { full_name: input.full_name, shop_name: input.clinic_name, phone: input.phone } } });
    if (error || !data.user) return res.status(400).json({ error: 'Could not create this account. Check your details or sign in if already registered.' });
    if (data.user.identities?.length === 0) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    authUserId = data.user.id;
    const clinicId = randomUUID();
    const slug = input.slug || `pharmacy-${clinicId}`;
    const trialEnd = new Date(Date.now() + 14 * 86400000).toISOString();
    const result = await sql.begin(async tx => {
      const [clinic] = await tx`INSERT INTO clinics(id,_local_id,name,slug,phone,email,gstin,drug_licence_number,plan,trial_ends_at)
        VALUES(${clinicId},${clinicId},${input.clinic_name},${slug},${input.phone},${input.email},${input.gstin || null},${input.drug_licence_number || null},'trial',${trialEnd}) RETURNING id,name,plan`;
      const [user] = await tx`INSERT INTO users(id,_local_id,clinic_id,full_name,email,phone,role)
        VALUES(${data.user!.id},${data.user!.id},${clinicId},${input.full_name},${input.email},${input.phone},'OWNER') RETURNING id,clinic_id,full_name,email,role`;
      await tx`INSERT INTO clinic_subscriptions(clinic_id,plan_name,status,billing_cycle,trial_end) VALUES(${clinicId},'trial','trial','monthly',${trialEnd})`;
      return { clinic, user };
    });
    return res.status(201).json({ success: true, data: { ...result, session: data.session,
      requiresEmailConfirmation: !data.session } });
  } catch (error) {
    if (authUserId) {
      const cleanup = await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => ({ error: true }));
      if (cleanup.error) console.error('[register] Account cleanup needs attention');
    }
    const conflict = (error as { code?: string }).code === '23505';
    return res.status(conflict ? 409 : 503).json({ error: conflict ? 'That pharmacy address is already in use. Choose another address.' : 'Account setup is temporarily unavailable. Please retry.' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
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

    if (authError && (authError.status === 0 || (authError.status || 0) >= 500)) return res.status(503).json({ success: false, error: 'Sign-in is temporarily unavailable. Please retry.' });
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
      console.error('[login] User profile lookup failed');
      return res.status(503).json({ success: false, error: 'Account verification is temporarily unavailable. Please retry.' });
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
        return res.status(503).json({ success: false, error: 'Account setup is temporarily unavailable. Please retry.' });
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
  const refreshToken = req.body?.refreshToken || req.cookies?.refreshToken;
  if (!refreshToken) return res.status(401).json({ success: false, error: 'No refresh token' });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: 'Authentication is not configured. Contact support.' });
  const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(refreshToken, refreshSecret);
    if (typeof verified === 'string' || !verified.sub ||
        (verified.token_use !== 'refresh' && !(verified.token_use === undefined && typeof verified.exp === 'number' && typeof verified.iat === 'number' && verified.exp - verified.iat > 900))) throw new Error('Invalid refresh token');
    payload = verified;
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }

  try {
    const { data: user, error } = await supabaseAdmin
      .from('users').select('id, role, clinic_id').eq('id', payload.sub).single();
    if (error && error.code !== 'PGRST116') {
      return res.status(503).json({ success: false, error: 'Authentication is temporarily unavailable. Please retry.' });
    }
    if (!user) return res.status(401).json({ success: false, error: 'User no longer exists' });
    // Re-read role/store assignments on renewal instead of perpetuating old claims.
    const claims = { sub: user.id, clinic_id: user.clinic_id, role: user.role, plan: payload.plan };
    const accessToken = jwt.sign({ ...claims, token_use: 'access' }, secret, { expiresIn: '15m' });
    const nextRefreshToken = jwt.sign({ ...claims, token_use: 'refresh' }, refreshSecret, { expiresIn: '30d' });
    res.cookie('refreshToken', nextRefreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 });
    return res.status(200).json({ success: true, data: { accessToken, refreshToken: nextRefreshToken } });
  } catch {
    // A database/network outage does not invalidate an otherwise valid refresh token.
    return res.status(503).json({ success: false, error: 'Authentication is temporarily unavailable. Please retry.' });
  }
};
