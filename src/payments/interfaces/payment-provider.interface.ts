/**
 * Unified payment provider abstraction.
 *
 * Every provider (Paystack, Monnify, Blockradar, ...) implements this
 * interface so that `PaymentsService` can route operations without
 * caring about provider-specific details. Amounts at the boundary are
 * always in NGN; each provider handles its own internal unit (kobo,
 * naira, USD equivalent, etc.).
 */

export interface InitPaymentDto {
  /** Amount in NGN (provider converts internally). */
  amount: number;
  email: string;
  /** Unique transaction reference, e.g. "HOSTIT_TXN_ABC123". */
  reference: string;
  /** Where the provider should redirect after checkout. */
  callbackUrl: string;
  /** Free-form metadata forwarded to the provider. */
  metadata: Record<string, any>;
}

export interface PaymentInitResult {
  /** URL the buyer is redirected to. May be null for non-redirect flows. */
  checkoutUrl: string | null;
  /** Our reference (echoed back). */
  reference: string;
  /** Provider's own internal reference, if any. */
  providerReference?: string;
}

export type PaymentVerifyStatus = 'success' | 'failed' | 'pending';

export interface PaymentVerifyResult {
  status: PaymentVerifyStatus;
  /** Amount in NGN (normalized from provider unit). */
  amount: number;
  reference: string;
  providerReference: string;
  paidAt?: Date;
  /** card | bank_transfer | ussd | ... — provider-specific. */
  channel?: string;
  metadata?: Record<string, any>;
}

export interface IPaymentProvider {
  initializePayment(data: InitPaymentDto): Promise<PaymentInitResult>;
  verifyPayment(reference: string): Promise<PaymentVerifyResult>;
  /**
   * Verify a webhook payload against its signature header.
   * `body` is the raw request body (string or Buffer for some providers).
   */
  verifyWebhookSignature(body: any, signature: string): boolean;
}
