import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by verifySuperAdminSchoolMiddleware (school / ops Supabase auth). */
      superAdmin?: { id: string; email: string };
    }
  }
}

let schoolAnon: SupabaseClient | null = null;
let schoolAdmin: SupabaseClient | null = null;

function getSchoolClients(): { anon: SupabaseClient; admin: SupabaseClient } | null {
  const url = process.env.SCHOOL_OPS_SUPABASE_URL?.trim();
  const anonKey = process.env.SCHOOL_OPS_SUPABASE_ANON_KEY?.trim();
  const serviceKey = process.env.SCHOOL_OPS_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anonKey || !serviceKey) {
    return null;
  }
  if (!schoolAnon || !schoolAdmin) {
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    schoolAnon = createClient(url, anonKey, opts);
    schoolAdmin = createClient(url, serviceKey, opts);
  }
  return { anon: schoolAnon, admin: schoolAdmin };
}

/** Same contract as SupabaseBackend verifySuperAdminMiddleware: Bearer = school Supabase JWT; user must be active super_admin or founder. */
export const verifySuperAdminSchoolMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clients = getSchoolClients();
    if (!clients) {
      return res.status(503).json({
        error: 'Super-admin auth is not configured (set SCHOOL_OPS_SUPABASE_URL, SCHOOL_OPS_SUPABASE_ANON_KEY, SCHOOL_OPS_SUPABASE_SERVICE_ROLE_KEY).',
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Malformed authorization header' });
    }

    const { data: { user }, error } = await clients.anon.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data: superAdminRow } = await clients.admin
      .from('super_admins')
      .select('id, is_active, email')
      .or(`id.eq.${user.id},email.ilike.${user.email}`)
      .limit(1)
      .maybeSingle();

    const { data: founderRow } = await clients.admin
      .from('founders')
      .select('id, user_id, is_active, email')
      .or(`user_id.eq.${user.id},email.ilike.${user.email}`)
      .limit(1)
      .maybeSingle();

    const isSuperAdminOK = superAdminRow && superAdminRow.is_active === true;
    const isFounderOK = founderRow && founderRow.is_active === true;

    if (!isSuperAdminOK && !isFounderOK) {
      return res.status(403).json({ error: 'Access denied. Account is deactivated or not found.' });
    }

    const activeRow = superAdminRow || founderRow;
    req.superAdmin = { id: user.id, email: activeRow!.email };
    next();
  } catch (err) {
    console.error('Super Admin Verification Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
