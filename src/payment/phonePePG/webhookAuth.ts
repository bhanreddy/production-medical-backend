import crypto from 'crypto';
import { env } from '../../config/env';

export function sha256HexUtf8(message: string): string {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

export function timingSafeEqualLowerHex(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al.length !== bl.length) return false;
  return crypto.timingSafeEqual(Buffer.from(al, 'utf8'), Buffer.from(bl, 'utf8'));
}

/**
 * Same scheme as `supabase/functions/webhook-phonepe`:
 * `Authorization` header must equal sha256hex(utf8(username + ":" + password)).
 */
export function verifyPhonePeWebhookCredentials(
  authHeader: string | undefined,
  username: string | undefined,
  password: string | undefined
): boolean {
  if (!username || !password || !authHeader) return false;
  const expected = sha256HexUtf8(`${username}:${password}`);
  return timingSafeEqualLowerHex(authHeader.trim(), expected);
}

export function verifyPhonePeWebhookAuthorization(authHeader: string | undefined): boolean {
  return verifyPhonePeWebhookCredentials(
    authHeader,
    env.PHONEPE_WEBHOOK_USERNAME,
    env.PHONEPE_WEBHOOK_PASSWORD
  );
}
