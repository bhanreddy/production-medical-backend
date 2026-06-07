/** Standard Checkout v2 — pay API JSON body response (subset). */
export type PhonePePayResponse = {
  orderId?: string;
  redirectUrl?: string;
  state?: string;
  code?: string;
  message?: string;
};

/** Order status API response (subset). */
export type PhonePeOrderStatus = {
  state?: string;
  orderId?: string;
  paymentDetails?: Array<{ state?: string; transactionId?: string }>;
  code?: string;
  message?: string;
};
