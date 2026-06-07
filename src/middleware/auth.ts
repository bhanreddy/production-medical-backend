import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../config/supabase';
import { AuthUser } from '../types';

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const jwtSecret = process.env.JWT_SECRET;

    /* ─── Path 1: Custom JWT (issued by Express /auth/login) ─── */
    if (jwtSecret) {
      try {
        const payload = jwt.verify(token, jwtSecret) as {
          sub: string;
          clinic_id: string;
          role: string;
          plan: string;
        };

        // Verify user still exists
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('id, role, clinic_id')
          .eq('id', payload.sub)
          .single();

        if (user) {
          let finalClinicId = payload.clinic_id;
          let isImpersonating = false;

          // Impersonation logic for super admins
          if (user.role === 'SUPER_ADMIN' || payload.role === 'SUPER_ADMIN') {
            const impersonateHeader = req.headers['x-impersonate-clinic'];
            if (impersonateHeader && typeof impersonateHeader === 'string') {
              finalClinicId = impersonateHeader;
              isImpersonating = true;
            }
          }

          req.user = {
            id: payload.sub,
            clinic_id: finalClinicId,
            role: (user.role || payload.role) as AuthUser['role'],
            email: '',
            isImpersonating,
          };
          return next();
        }
        // User deleted from DB — fall through to Supabase path or reject
      } catch (jwtErr) {
        // Token is not a custom JWT — fall through to Supabase verification
      }
    }

    /* ─── Path 2: Supabase Auth token (legacy / backward compat) ─── */
    const { data: { user: supabaseUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !supabaseUser) {
      console.error('[auth middleware] Token verification failed:', {
        message: authError?.message,
        tokenPrefix: token.substring(0, 20) + '...'
      });
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.log('[auth middleware] Verified Supabase user:', supabaseUser.email);
    const userId = supabaseUser.id;
    const email = supabaseUser.email || '';

    // Fetch additional user details (role, clinic_id) from our system's users table
    const { data: userRow, error } = await supabaseAdmin
      .from('users')
      .select('clinic_id, role')
      .eq('id', userId)
      .single();

    if (error || !userRow) {
      console.warn(`[auth middleware] User not found in DB. ID: ${userId}, Email: ${email}. Auto-provisioning...`);
      
      // Auto-provision: create a clinic + user row so sync has a valid clinic_id
      try {
        const meta = supabaseUser.user_metadata || {};
        const shopName = meta.shop_name || meta.clinic_name || email.split('@')[0] + "'s Clinic";

        // Check if there's already a clinic owned by this email (e.g., partial registration)
        const { data: existingClinic } = await supabaseAdmin
          .from('clinics')
          .select('id')
          .eq('email', email)
          .single();

        let clinicId: string;

        if (existingClinic) {
          clinicId = existingClinic.id;
          console.log(`[auth middleware] Found existing clinic ${clinicId} for ${email}`);
        } else {
          // Create a new clinic
          const { data: newClinic, error: clinicErr } = await supabaseAdmin
            .from('clinics')
            .insert({ name: shopName, email, plan: 'trial' })
            .select('id')
            .single();

          if (clinicErr || !newClinic) {
            console.error('[auth middleware] Failed to auto-create clinic:', clinicErr?.message);
            // Last resort fallback: proceed without clinic_id (sync will be disabled)
            req.user = { id: userId, clinic_id: null, role: 'OWNER', email, isImpersonating: false };
            return next();
          }
          clinicId = newClinic.id;
          console.log(`[auth middleware] Auto-created clinic ${clinicId} for ${email}`);
        }

        // Create user row
        const { error: userInsertErr } = await supabaseAdmin
          .from('users')
          .upsert({ id: userId, clinic_id: clinicId, full_name: meta.full_name || email.split('@')[0], role: 'OWNER' }, { onConflict: 'id' });

        if (userInsertErr) {
          console.error('[auth middleware] Failed to auto-create user row:', userInsertErr.message);
        } else {
          console.log(`[auth middleware] Auto-created user row for ${email} in clinic ${clinicId}`);
        }

        req.user = { id: userId, clinic_id: clinicId, role: 'OWNER', email, isImpersonating: false };
        return next();
      } catch (provisionErr: any) {
        console.error('[auth middleware] Auto-provision failed:', provisionErr.message);
        req.user = { id: userId, clinic_id: null, role: 'OWNER', email, isImpersonating: false };
        return next();
      }
    }

    let finalClinicId = userRow.clinic_id;
    let isImpersonating = false;

    // Impersonation logic
    if (userRow.role === 'SUPER_ADMIN') {
      const impersonateHeader = req.headers['x-impersonate-clinic'];
      if (impersonateHeader && typeof impersonateHeader === 'string') {
        finalClinicId = impersonateHeader;
        isImpersonating = true;
      }
    }

    req.user = {
      id: userId,
      clinic_id: finalClinicId,
      role: userRow.role as AuthUser['role'],
      email: email,
      isImpersonating
    };

    next();
  } catch (error) {
    next(error);
  }
};


export const requireRole = (roles: AuthUser['role'][]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (req.user.role === 'SUPER_ADMIN') {
      return next(); 
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
};
