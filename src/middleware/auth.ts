import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthUser } from '../types';
import { localDb } from '../local-db';
import { ensureCloudPosDirectory } from '../services/cloudPosDirectory';
import { getSupabaseUser, getUserProfile } from '../lib/supabaseIdentity';

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  // Parent router authentication is reusable within this request only.
  if (req.user) return next();
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
          token_use?: string;
          exp?: number;
          iat?: number;
        };

        if (payload.token_use === 'refresh' || (payload.token_use === undefined && payload.exp && payload.iat && payload.exp - payload.iat > 86400)) {
          return res.status(401).json({ error: 'An access token is required' });
        }

        // Check local DB first for fast offline execution and test speed
        let resolvedUser: any = null;
        if (!process.env.DATABASE_URL) {
          try {
            resolvedUser = localDb.prepare('SELECT id, role, clinic_id, is_active, _deleted FROM users WHERE id = ? OR _local_id = ?').get(payload.sub, payload.sub);
          } catch {}
        }

        if (!resolvedUser) {
          const profile = await getUserProfile(payload.sub);
          if (profile.error && profile.error.code !== 'PGRST116') return res.status(503).json({ error: 'Account verification is temporarily unavailable. Please retry.' });
          resolvedUser = profile.data;
        }

        if (resolvedUser) {
          if (resolvedUser.is_active === false || resolvedUser.is_active === 0 || resolvedUser._deleted || resolvedUser.deleted_at) return res.status(403).json({ error: 'Your account is inactive. Contact your administrator.' });
          let finalClinicId = resolvedUser.clinic_id;
          let isImpersonating = false;

          // Impersonation logic for super admins
          if (resolvedUser.role === 'SUPER_ADMIN') {
            const impersonateHeader = req.headers['x-impersonate-clinic'];
            if (impersonateHeader && typeof impersonateHeader === 'string') {
              finalClinicId = impersonateHeader;
              isImpersonating = true;
            }
          }

          req.user = {
            id: payload.sub,
            clinic_id: finalClinicId,
            role: resolvedUser.role as AuthUser['role'],
            email: resolvedUser.email || '',
            isImpersonating,
          };
          if (process.env.DATABASE_URL) {
            const organizationId = await ensureCloudPosDirectory(req.user, resolvedUser.full_name);
            if (organizationId) { req.user.organization_id = organizationId; req.user.organizationId = organizationId; }
          }
          return next();
        }
        // User deleted from DB — fall through to Supabase path or reject
      } catch (jwtErr) {
        if (!(jwtErr instanceof jwt.JsonWebTokenError || jwtErr instanceof jwt.NotBeforeError)) return next(jwtErr);
        // Token is not a custom JWT — fall through to Supabase verification
      }
    }

    /* ─── Path 2: Supabase Auth token (legacy / backward compat) ─── */
    const { user: supabaseUser, error: authError } = await getSupabaseUser(token);

    if (authError || !supabaseUser) {
      console.error('[auth middleware] Token verification failed:', authError?.message);
      if (authError && (authError.status === 0 || (authError.status || 0) >= 500 || authError.name === 'AuthRetryableFetchError')) {
        return res.status(503).json({ error: 'Sign-in verification is temporarily unavailable. Please retry.' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }


    const userId = supabaseUser.id;
    const email = supabaseUser.email || '';

    // Fetch additional user details (role, clinic_id) from our system's users table
    const { data: userRow, error } = await getUserProfile(userId);

    if (error && error.code !== 'PGRST116') return res.status(503).json({ error: 'Account verification is temporarily unavailable. Please retry.' });
    if (!userRow) {
      // Missing account setup is not evidence of an OWNER role. Registration must provision it.
      return res.status(403).json({ error: { message: 'Your account setup is incomplete. Contact your administrator.', code: 'PROFILE_NOT_CONFIGURED' } });
    }

    if (userRow.is_active === false || userRow.deleted_at) return res.status(403).json({ error: 'Your account is inactive. Contact your administrator.' });

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

    const organizationId = await ensureCloudPosDirectory(req.user, userRow.full_name || supabaseUser.user_metadata?.full_name);
    if (organizationId) { req.user.organization_id = organizationId; req.user.organizationId = organizationId; }
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
