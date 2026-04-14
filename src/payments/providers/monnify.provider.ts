import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
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

interface MonnifyAuthResponse {
  accessToken: string;
  expiresIn: number; // seconds
}

interface MonnifyInitResponse {
  transactionReference: string;
  paymentReference: string;
  checkoutUrl: string;
}

interface MonnifyVerifyResponse {
  paymentStatus: string; // PAID | PENDING | FAILED | EXPIRED
  amountPaid: number; // Naira
  paymentReference: string;
  transactionReference: string;
  paymentMethod?: string;
  currency?: string;
  paidOn?: string;
  metaData?: Record<string, any>;
}

/**
 * Monnify provider — Naira (no kobo conversion), OAuth-bearer auth
 * with a 1h token, SHA512(secret|body) webhook signatures.
 *
 * Token cache lives in-memory with a single in-flight refresh
 * promise so concurrent callers don't trigger duplicate logins.
 */
@Injectable()
export class MonnifyProvider implements IPaymentProvider {
  private readonly logger = new Logger(MonnifyProvider.name);
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly contractCode: string;
  private readonly baseUrl: string;

  /** Refresh `REFRESH_BUFFER_SECONDS` before the real expiry. */
  private static readonly REFRESH_BUFFER_SECONDS = 600; // 10 min

  private cachedToken: { token: string; expiresAt: number } | null = null;
  private inflightAuth: Promise<string> | null = null;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('monnify.apiKey');
    this.secretKey = configService.getOrThrow<string>('monnify.secretKey');
    this.contractCode = configService.getOrThrow<string>(
      'monnify.contractCode',
    );
    this.baseUrl = configService.getOrThrow<string>('monnify.baseUrl');
  }

  async initializePayment(data: InitPaymentDto): Promise<PaymentInitResult> {
    const body: Record<string, unknown> = {
      amount: data.amount, // Naira, no conversion
      customerName: this.deriveCustomerName(data),
      customerEmail: data.email,
      paymentReference: data.reference,
      // Monnify caps paymentDescription at ~100 chars in practice.
      paymentDescription: (
        (data.metadata?.description as string) ?? 'HostIT ticket purchase'
      ).slice(0, 100),
      currencyCode: 'NGN',
      contractCode: this.contractCode,
      redirectUrl: data.callbackUrl,
      // NQR is gated per-merchant — leave it off so sandbox + new
      // accounts don't get rejected with a generic "malformed" error.
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
      // Monnify expects metaData as a flat string→string map. Nested
      // objects/arrays trip their validator silently.
      metaData: this.flattenMetadata(data.metadata),
    };

    // Split settlement: send the organizer's share to their subaccount
    // as a fixed NGN amount (mirrors Paystack's exact-amount approach
    // for symmetric ledger entries). The remainder lands in HostIT's
    // main merchant balance — that's the 3% platform fee.
    if (data.split) {
      const organizerAmount = data.amount - data.split.platformAmount;
      body.incomeSplitConfig = [
        {
          subAccountCode: data.split.subaccountCode,
          splitAmount: organizerAmount,
          feeBearer: data.split.feeBearer === 'ORGANIZER',
        },
      ];
    }

    const res = await this.authedRequest<MonnifyInitResponse>(
      '/api/v1/merchant/transactions/init-transaction',
      { method: 'POST', body: JSON.stringify(body) },
    );

    return {
      checkoutUrl: res.checkoutUrl,
      reference: res.paymentReference,
      providerReference: res.transactionReference,
    };
  }

  async verifyPayment(reference: string): Promise<PaymentVerifyResult> {
    // Monnify's v2 verify endpoint takes the URL-encoded
    // transactionReference. We accept either reference here — callers
    // typically pass the providerReference back, but our paymentReference
    // also works against the alternate endpoint.
    const res = await this.authedRequest<MonnifyVerifyResponse>(
      `/api/v2/transactions/${encodeURIComponent(reference)}`,
    );

    return {
      status: this.mapStatus(res.paymentStatus),
      amount: res.amountPaid, // already in NGN
      reference: res.paymentReference,
      providerReference: res.transactionReference,
      paidAt: res.paidOn ? new Date(res.paidOn) : undefined,
      channel: res.paymentMethod,
      metadata: res.metaData,
    };
  }

  /**
   * Creates a Monnify sub-account that becomes the settlement target
   * for this organizer's tickets. Monnify's endpoint is batch-shaped
   * (always takes/returns an array) even when creating one — we call
   * with a single-element array and return the first result.
   *
   * `defaultSplitPercentage: 0` so the per-transaction `incomeSplitConfig`
   * we send at init time is the only thing controlling the split.
   */
  async createSubAccount(params: {
    bankCode: string;
    accountNumber: string;
    email: string;
  }): Promise<{ subAccountCode: string; accountName: string }> {
    const res = await this.authedRequest<
      Array<{
        subAccountCode: string;
        accountName: string;
        accountNumber: string;
      }>
    >('/api/v1/sub-accounts', {
      method: 'POST',
      body: JSON.stringify([
        {
          currencyCode: 'NGN',
          bankCode: params.bankCode,
          accountNumber: params.accountNumber,
          email: params.email,
          defaultSplitPercentage: 0,
        },
      ]),
    });

    const created = res?.[0];
    if (!created?.subAccountCode) {
      throw new BadGatewayException(
        'Monnify: sub-account creation returned empty response',
      );
    }
    return {
      subAccountCode: created.subAccountCode,
      accountName: created.accountName,
    };
  }

  /**
   * SHA512(secret + "|" + raw body), hex-encoded.
   * Pass the exact raw body — re-stringifying a parsed object would
   * change byte order and break the hash.
   */
  verifyWebhookSignature(body: string | Buffer, signature: string): boolean {
    if (!signature) return false;
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    const computed = crypto
      .createHash('sha512')
      .update(`${this.secretKey}|${raw}`)
      .digest('hex');

    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ─────────────── auth ───────────────

  /**
   * Returns a valid bearer token, refreshing if expired or near expiry.
   * Concurrent callers share a single in-flight refresh promise.
   */
  private async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.token;
    }
    if (this.inflightAuth) return this.inflightAuth;

    this.inflightAuth = this.authenticate()
      .then((token) => {
        this.inflightAuth = null;
        return token;
      })
      .catch((err) => {
        this.inflightAuth = null;
        throw err;
      });
    return this.inflightAuth;
  }

  private async authenticate(): Promise<string> {
    const basic = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString(
      'base64',
    );

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      this.logger.error('Monnify auth network error', err as Error);
      throw new ServiceUnavailableException(
        'Payment provider unreachable, please retry',
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      requestSuccessful?: boolean;
      responseMessage?: string;
      responseBody?: MonnifyAuthResponse;
    } | null;

    if (
      !response.ok ||
      !payload?.requestSuccessful ||
      !payload.responseBody?.accessToken
    ) {
      const msg = payload?.responseMessage ?? `HTTP ${response.status}`;
      this.logger.error(`Monnify auth failed: ${msg}`);
      throw new UnauthorizedException(`Monnify auth: ${msg}`);
    }

    const { accessToken, expiresIn } = payload.responseBody;
    const expiresAt =
      Math.floor(Date.now() / 1000) +
      expiresIn -
      MonnifyProvider.REFRESH_BUFFER_SECONDS;
    this.cachedToken = { token: accessToken, expiresAt };
    return accessToken;
  }

  // ─────────────── http helpers ───────────────

  private async authedRequest<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const token = await this.getAccessToken();
    return this.request<T>(path, token, init);
  }

  private async request<T>(
    path: string,
    token: string,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (err) {
      this.logger.error(`Monnify network error on ${path}`, err as Error);
      throw new ServiceUnavailableException(
        'Payment provider unreachable, please retry',
      );
    }

    type Envelope = {
      requestSuccessful: boolean;
      responseMessage: string;
      responseBody: T;
    };
    let payload: Envelope | null = null;
    try {
      payload = (await response.json()) as Envelope;
    } catch {
      // fall through
    }

    // Token might have been revoked server-side before our cache expiry —
    // bust the cache so the next call re-authenticates.
    if (response.status === 401) {
      this.cachedToken = null;
      throw new UnauthorizedException('Monnify token rejected');
    }

    if (!response.ok || !payload || !payload.requestSuccessful) {
      const message = payload?.responseMessage ?? `HTTP ${response.status}`;
      this.logger.error(`Monnify API error on ${path}: ${message}`);
      throw new BadGatewayException(`Monnify: ${message}`);
    }

    return payload.responseBody;
  }

  private mapStatus(status: string): PaymentVerifyStatus {
    switch (status?.toUpperCase()) {
      case 'PAID':
        return 'success';
      case 'FAILED':
      case 'EXPIRED':
      case 'REVERSED':
        return 'failed';
      case 'PENDING':
      default:
        return 'pending';
    }
  }

  /**
   * Monnify's metaData field requires flat string values. Flatten any
   * nested object/array entries to JSON strings so the field still
   * survives the round-trip without breaking their validator.
   */
  private flattenMetadata(
    metadata: Record<string, any> | undefined,
  ): Record<string, string> {
    if (!metadata) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v == null) continue;
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }

  private deriveCustomerName(data: InitPaymentDto): string {
    const fromMeta = data.metadata?.customerName as string | undefined;
    if (fromMeta) return fromMeta;
    // Fallback: derive a usable name from the email local part so the
    // Monnify API requirement is satisfied without leaking PII.
    const local = data.email.split('@')[0] ?? 'Customer';
    return local.slice(0, 50);
  }
}
