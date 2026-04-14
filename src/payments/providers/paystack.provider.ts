import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  IPaymentProvider,
  InitPaymentDto,
  PaymentInitResult,
  PaymentVerifyResult,
  PaymentVerifyStatus,
} from '../interfaces/payment-provider.interface';

interface PaystackInitResponse {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface PaystackVerifyResponse {
  status: string; // "success" | "failed" | "abandoned" | ...
  reference: string;
  amount: number; // kobo
  currency: string;
  channel?: string;
  paid_at?: string;
  metadata?: Record<string, any>;
  id?: number;
}

/**
 * Paystack provider — Naira via kobo (×100), static secret key auth,
 * HMAC-SHA512 webhook signatures.
 *
 * Self-contained from the KYC-focused `PaystackService` in `src/paystack/`
 * so the payments module stays independently composable.
 */
@Injectable()
export class PaystackProvider implements IPaymentProvider {
  private readonly logger = new Logger(PaystackProvider.name);
  private readonly secretKey: string;
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(configService: ConfigService) {
    this.secretKey = configService.getOrThrow<string>('paystack.secretKey');
  }

  async initializePayment(data: InitPaymentDto): Promise<PaymentInitResult> {
    const body = {
      email: data.email,
      amount: data.amount * 100, // NGN → kobo
      reference: data.reference,
      callback_url: data.callbackUrl,
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: data.metadata,
    };

    const res = await this.request<PaystackInitResponse>(
      '/transaction/initialize',
      { method: 'POST', body: JSON.stringify(body) },
    );

    return {
      checkoutUrl: res.authorization_url,
      reference: res.reference,
      providerReference: res.access_code,
    };
  }

  async verifyPayment(reference: string): Promise<PaymentVerifyResult> {
    const res = await this.request<PaystackVerifyResponse>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    return {
      status: this.mapStatus(res.status),
      amount: res.amount / 100, // kobo → NGN
      reference: res.reference,
      providerReference: res.id ? String(res.id) : res.reference,
      paidAt: res.paid_at ? new Date(res.paid_at) : undefined,
      channel: res.channel,
      metadata: res.metadata,
    };
  }

  /**
   * HMAC-SHA512 of the raw request body, keyed with the secret.
   * Caller must pass the exact raw body string (NOT a re-stringified
   * parsed object) — JSON re-serialization would change byte order.
   */
  verifyWebhookSignature(body: string | Buffer, signature: string): boolean {
    if (!signature) return false;
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const computed = crypto
      .createHmac('sha512', this.secretKey)
      .update(raw)
      .digest('hex');

    // Constant-time compare to dodge timing leaks.
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private mapStatus(paystackStatus: string): PaymentVerifyStatus {
    switch (paystackStatus) {
      case 'success':
        return 'success';
      case 'failed':
      case 'abandoned':
      case 'reversed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (err) {
      this.logger.error(`Paystack network error on ${path}`, err as Error);
      throw new ServiceUnavailableException(
        'Payment provider unreachable, please retry',
      );
    }

    type Envelope = { status: boolean; message: string; data: T };
    let payload: Envelope | null = null;
    try {
      payload = (await response.json()) as Envelope;
    } catch {
      // fall through to BadGateway below
    }

    if (!response.ok || !payload || !payload.status) {
      const message = payload?.message ?? `HTTP ${response.status}`;
      this.logger.error(`Paystack API error on ${path}: ${message}`);
      throw new BadGatewayException(`Paystack: ${message}`);
    }

    return payload.data;
  }
}
