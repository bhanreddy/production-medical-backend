import crypto from 'crypto';
import {
  sha256HexUtf8,
  timingSafeEqualLowerHex,
  verifyPhonePeWebhookCredentials,
} from '../payment/phonePePG';

describe('PhonePe webhook credentials', () => {
  it('rejects missing credentials or header', () => {
    expect(verifyPhonePeWebhookCredentials(undefined, 'u', 'p')).toBe(false);
    expect(verifyPhonePeWebhookCredentials('abc', undefined, 'p')).toBe(false);
    expect(verifyPhonePeWebhookCredentials('abc', 'u', undefined)).toBe(false);
  });

  it('accepts Authorization equal to sha256hex(username:password)', () => {
    const user = 'webhook_user';
    const pass = 'webhook_pass';
    const expected = sha256HexUtf8(`${user}:${pass}`);
    expect(verifyPhonePeWebhookCredentials(expected, user, pass)).toBe(true);
    expect(verifyPhonePeWebhookCredentials(expected.toUpperCase(), user, pass)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const user = 'webhook_user';
    const pass = 'webhook_pass';
    const wrong = sha256HexUtf8(`${user}:other`);
    expect(verifyPhonePeWebhookCredentials(wrong, user, pass)).toBe(false);
  });

  it('computes same HMAC-style digest as manual sha256', () => {
    const user = 'a';
    const pass = 'b';
    const manual = crypto.createHash('sha256').update(`${user}:${pass}`, 'utf8').digest('hex');
    expect(sha256HexUtf8(`${user}:${pass}`)).toBe(manual);
  });

  it('timingSafeEqualLowerHex rejects different lengths', () => {
    expect(timingSafeEqualLowerHex('ab', 'abc')).toBe(false);
  });
});
