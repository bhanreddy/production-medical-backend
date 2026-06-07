import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Match env.ts so imports that load before `env` still see `.env.development` / `.env.production`, etc.
const nodeEnv = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });
dotenv.config();

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in `.env.development` in this project folder (see `.env.example`), then restart the dev server.'
  );
}

// Service role client - bypassing RLS for admin tasks and cross-tenant checks inside backend routes
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
