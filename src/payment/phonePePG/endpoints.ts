import { env } from '../../config/env';

export type PhonePeRuntimeEndpoints = {
  production: boolean;
  oauthUrl: string;
  checkoutPayUrl: string;
  orderStatusUrl: (merchantOrderId: string) => string;
};

/** Resolves OAuth, pay, and status URLs from `PHONEPE_ENV` (sandbox vs production). */
export function phonePeEndpoints(): PhonePeRuntimeEndpoints {
  const pe = (env.PHONEPE_ENV || 'SANDBOX').toUpperCase();
  const production = pe === 'PRODUCTION' || pe === 'PROD';
  return {
    production,
    oauthUrl: production
      ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    checkoutPayUrl: production
      ? 'https://api.phonepe.com/apis/pg/checkout/v2/pay'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay',
    orderStatusUrl: (merchantOrderId: string) =>
      production
        ? `https://api.phonepe.com/apis/pg/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`
        : `https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`,
  };
}
