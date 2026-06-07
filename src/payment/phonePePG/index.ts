/**
 * PhonePe Payment Gateway — Standard Checkout v2 (OAuth + REST).
 * @see https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/
 */

export type { PhonePePayResponse, PhonePeOrderStatus } from './types';
export { phonePeEndpoints } from './endpoints';
export type { PhonePeRuntimeEndpoints } from './endpoints';
export {
  getPhonePeAuthorizationHeader,
  merchantHeaders,
  phonePeCreateCheckoutPay,
  phonePeFetchOrderStatus,
} from './client';
export { makeClinicMerchantOrderId } from './merchantOrderId';
export {
  sha256HexUtf8,
  timingSafeEqualLowerHex,
  verifyPhonePeWebhookCredentials,
  verifyPhonePeWebhookAuthorization,
} from './webhookAuth';

import { phonePeEndpoints } from './endpoints';
import {
  getPhonePeAuthorizationHeader,
  merchantHeaders,
  phonePeCreateCheckoutPay,
  phonePeFetchOrderStatus,
} from './client';
import { makeClinicMerchantOrderId } from './merchantOrderId';
import {
  sha256HexUtf8,
  timingSafeEqualLowerHex,
  verifyPhonePeWebhookCredentials,
  verifyPhonePeWebhookAuthorization,
} from './webhookAuth';

/** Single namespace for consumers that prefer `PhonePePG.*` style imports. */
export const PhonePePG = {
  endpoints: phonePeEndpoints,
  getAuthorizationHeader: getPhonePeAuthorizationHeader,
  merchantHeaders,
  createCheckoutPay: phonePeCreateCheckoutPay,
  fetchOrderStatus: phonePeFetchOrderStatus,
  makeClinicMerchantOrderId,
  verifyWebhookAuthorization: verifyPhonePeWebhookAuthorization,
  verifyWebhookCredentials: verifyPhonePeWebhookCredentials,
  sha256HexUtf8,
  timingSafeEqualLowerHex,
} as const;
