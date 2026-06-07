import { requireAuth } from './auth';

// Protected routes middleware using Supabase Auth
export const authenticateJWT = requireAuth;

