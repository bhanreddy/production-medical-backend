/** PhonePe: merchantOrderId max 63 chars; charset [A-Za-z0-9_-]. */
export function makeClinicMerchantOrderId(clinicSubscriptionId: string): string {
  const compact = clinicSubscriptionId.replace(/-/g, '');
  const base = `MCL-${compact}`;
  return base.length <= 63 ? base : base.slice(0, 63);
}
