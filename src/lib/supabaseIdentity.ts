import { createPublicKey, type JsonWebKey, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import type { AuthError } from '@supabase/supabase-js';
import { supabaseAdmin } from '../config/supabase';

export interface SupabaseIdentity {
  id: string;
  email: string;
  user_metadata: Record<string, any>;
}

export interface UserProfile {
  clinic_id: string | null;
  role: string;
  full_name: string | null;
}

type ProfileResult = { data: UserProfile | null; error: { code?: string; message?: string } | null };

const SIGNING_KEYS_TTL_MS = 10 * 60_000;
const SIGNING_KEYS_RETRY_MS = 30_000;
const PROFILE_TTL_MS = 60_000;

let signingKeys = new Map<string, KeyObject>();
let signingKeysAt = 0;
let signingKeysAttemptAt = 0;
let signingKeysLoading: Promise<void> | null = null;
const profiles = new Map<string, { profile: UserProfile; at: number }>();
const profileLoads = new Map<string, Promise<ProfileResult>>();

async function loadSigningKeys(): Promise<void> {
  signingKeysAttemptAt = Date.now();
  try {
    const response = await fetch(`${(process.env.SUPABASE_URL || '').trim()}/auth/v1/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const { keys = [] } = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const next = new Map<string, KeyObject>();
    for (const key of keys) {
      try {
        if (key.kid) next.set(key.kid, createPublicKey({ key, format: 'jwk' }));
      } catch {
        /* Unsupported key type */
      }
    }
    signingKeys = next;
    signingKeysAt = Date.now();
  } catch {
    /* Unreachable key set: tokens fall back to Supabase Auth. */
  }
}

function refreshSigningKeys(): Promise<void> {
  signingKeysLoading ??= loadSigningKeys().finally(() => {
    signingKeysLoading = null;
  });
  return signingKeysLoading;
}

async function publicKey(kid: string): Promise<KeyObject | undefined> {
  const canRefresh = Date.now() - signingKeysAttemptAt > SIGNING_KEYS_RETRY_MS;
  const known = signingKeys.get(kid);
  if (known) {
    if (canRefresh && Date.now() - signingKeysAt > SIGNING_KEYS_TTL_MS) void refreshSigningKeys();
    return known;
  }
  if (signingKeysLoading || canRefresh) await refreshSigningKeys();
  return signingKeys.get(kid);
}

async function verifyLocally(token: string): Promise<SupabaseIdentity | null> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string') return null;
  const { alg, kid } = decoded.header;
  const key =
    alg === 'HS256'
      ? (process.env.SUPABASE_JWT_SECRET || '').trim() || undefined
      : (alg === 'ES256' || alg === 'RS256') && kid
        ? await publicKey(kid)
        : undefined;
  if (!key) return null;
  try {
    const claims = jwt.verify(token, key, { algorithms: [alg as jwt.Algorithm] }) as jwt.JwtPayload;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    // The anon and service-role API keys are signed with the same secret but are not user sessions.
    if (typeof claims.sub !== 'string' || claims.role !== 'authenticated' || !audiences.includes('authenticated')) return null;
    return {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      user_metadata: claims.user_metadata ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Supabase session owner. Signed, unexpired session tokens are verified in-process;
 * anything else is decided by Supabase Auth exactly as before.
 */
export async function getSupabaseUser(
  token: string,
): Promise<{ user: SupabaseIdentity | null; error: AuthError | null }> {
  const local = await verifyLocally(token);
  if (local) return { user: local, error: null };
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  const user = data?.user;
  return {
    user: user ? { id: user.id, email: user.email || '', user_metadata: user.user_metadata || {} } : null,
    error,
  };
}

/** Direct database read when the pool is configured; Supabase otherwise, which is what the tests use. */
async function fetchProfile(userId: string): Promise<ProfileResult> {
  if (process.env.DATABASE_URL) {
    try {
      const { queryRaw } = await import('./postgresDb');
      const rows = await queryRaw<UserProfile>(
        'SELECT clinic_id, role, full_name FROM users WHERE id = ?',
        [userId],
      );
      const data = rows[0] ?? null;
      return { data, error: data ? null : { code: 'PGRST116', message: 'No rows' } };
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : 'profile lookup failed' } };
    }
  }
  const { data, error } = await supabaseAdmin.from('users').select('clinic_id, role, full_name').eq('id', userId).single();
  return { data, error };
}

/** Role and store assignment. Reused briefly so concurrent and back-to-back requests share one lookup. */
export function getUserProfile(userId: string): Promise<ProfileResult> {
  const cached = profiles.get(userId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return Promise.resolve({ data: cached.profile, error: null });
  const pending = profileLoads.get(userId);
  if (pending) return pending;
  const load = fetchProfile(userId)
    .then(({ data, error }): ProfileResult => {
      if (data) {
        profiles.set(userId, { profile: data, at: Date.now() });
        if (profiles.size > 2000)
          for (const [id, entry] of profiles) if (Date.now() - entry.at >= PROFILE_TTL_MS) profiles.delete(id);
      }
      return { data, error };
    })
    .finally(() => profileLoads.delete(userId));
  profileLoads.set(userId, load);
  return load;
}

/** Test isolation only. */
export function resetSupabaseIdentityCache(): void {
  profiles.clear();
  profileLoads.clear();
  signingKeys = new Map();
  signingKeysAt = 0;
  signingKeysAttemptAt = 0;
  signingKeysLoading = null;
}
