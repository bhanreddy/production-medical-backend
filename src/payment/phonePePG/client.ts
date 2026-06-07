import { env } from '../../config/env';
import type { PhonePeOrderStatus, PhonePePayResponse } from './types';
import { phonePeEndpoints } from './endpoints';

type TokenCache = { token: string; expiresAtSec: number };
let tokenCache: TokenCache | null = null;

export async function getPhonePeAuthorizationHeader(): Promise<string> {
  const clientId = env.PHONEPE_CLIENT_ID;
  const clientSecret = env.PHONEPE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET are not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAtSec > now + 120) {
    return `O-Bearer ${tokenCache.token}`;
  }

  const clientVersion = env.PHONEPE_CLIENT_VERSION || '1';
  const { oauthUrl } = phonePeEndpoints();
  const body = new URLSearchParams({
    client_id: clientId,
    client_version: clientVersion,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_at?: number;
    message?: string;
  };

  if (!res.ok || !json.access_token) {
    throw new Error(json.message || `PhonePe OAuth failed (${res.status})`);
  }

  const expiresAt = typeof json.expires_at === 'number' ? json.expires_at : now + 25 * 3600;
  tokenCache = { token: json.access_token, expiresAtSec: expiresAt };
  return `O-Bearer ${json.access_token}`;
}

export function merchantHeaders(authz: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: authz,
  };
  const mid = env.PHONEPE_MERCHANT_ID;
  if (mid) h['X-MERCHANT-ID'] = mid;
  return h;
}

export async function phonePeCreateCheckoutPay(
  body: Record<string, unknown>
): Promise<{ ok: boolean; data: PhonePePayResponse }> {
  const authz = await getPhonePeAuthorizationHeader();
  const { checkoutPayUrl } = phonePeEndpoints();
  const res = await fetch(checkoutPayUrl, {
    method: 'POST',
    headers: merchantHeaders(authz),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as PhonePePayResponse;
  return { ok: res.ok, data };
}

export async function phonePeFetchOrderStatus(
  merchantOrderId: string
): Promise<{ ok: boolean; data: PhonePeOrderStatus }> {
  const authz = await getPhonePeAuthorizationHeader();
  const url = phonePeEndpoints().orderStatusUrl(merchantOrderId);
  const res = await fetch(url, { method: 'GET', headers: merchantHeaders(authz) });
  const data = (await res.json()) as PhonePeOrderStatus;
  return { ok: res.ok, data };
}
