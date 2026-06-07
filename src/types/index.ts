export type Role = 'SUPER_ADMIN' | 'OWNER' | 'PHARMACIST' | 'CASHIER' | 'VIEWER';
export type Plan = 'trial' | 'basic' | 'pro' | 'custom';

export interface AuthUser {
  id: string;           // Supabase auth.uid()
  clinic_id: string | null;    // Resolved from users table, null if SUPER_ADMIN and not impersonating
  role: Role;
  email: string;
  isImpersonating?: boolean;
  plan?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

