import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify, KeyObject } from 'node:crypto';

/**
 * Circle notification envelope (webhook v2). The `notification` field
 * carries the resource-specific payload (a transaction object for
 * `transactions.*`, `{ hello: "world" }` for `webhooks.test`, etc.).
 */
export interface CircleNotification {
  subscriptionId?: string;
  notificationId?: string;
  notificationType?: string;
  notification?: Record<string, unknown>;
  timestamp?: string;
  version?: number;
}

/**
 * Verifies Circle webhook signatures.
 *
 * Scheme (per https://developers.circle.com/wallets/webhook-notifications):
 *  - Each delivery carries `X-Circle-Signature` (base64 ECDSA signature)
 *    and `X-Circle-Key-Id` (UUID of the signing key).
 *  - The public key is fetched once per keyId from
 *    `GET /v2/notifications/publicKey/{keyId}` and returned as a
 *    base64-encoded DER (SPKI) ECDSA P-256 key (`algorithm: ECDSA_SHA_256`).
 *  - The signature is over the raw request body as a UTF-8 JSON string.
 *
 * Public keys are cached in-memory by keyId — they rotate rarely and a
 * cache miss simply re-fetches.
 */
@Injectable()
export class CircleWebhookService {
  private readonly logger = new Logger(CircleWebhookService.name);
  private readonly keyCache = new Map<string, KeyObject>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Verify a webhook delivery. Returns false (never throws) on any
   * failure — missing headers, unknown key, fetch error, or signature
   * mismatch — so the caller can uniformly reject with 403.
   */
  async verify(
    rawBody: string,
    signature: string | undefined,
    keyId: string | undefined,
  ): Promise<boolean> {
    if (!signature || !keyId) {
      this.logger.warn('Circle webhook: missing signature or key id header');
      return false;
    }

    try {
      const publicKey = await this.getPublicKey(keyId);
      if (!publicKey) return false;

      // ECDSA over SHA-256; Circle's base64 signature is DER-encoded,
      // which is Node's default dsaEncoding for EC verify.
      return createVerify('SHA256')
        .update(rawBody, 'utf8')
        .verify(publicKey, signature, 'base64');
    } catch (err) {
      this.logger.warn(
        `Circle webhook: verification error: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async getPublicKey(keyId: string): Promise<KeyObject | null> {
    const cached = this.keyCache.get(keyId);
    if (cached) return cached;

    const base = this.config.getOrThrow<string>('circle.apiBaseUrl');
    const apiKey = this.config.getOrThrow<string>('circle.apiKey');

    const res = await fetch(`${base}/v2/notifications/publicKey/${keyId}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    });

    if (!res.ok) {
      this.logger.warn(
        `Circle webhook: public key fetch failed (keyId=${keyId}, status=${res.status})`,
      );
      return null;
    }

    const body = (await res.json()) as {
      data?: { publicKey?: string; algorithm?: string };
    };
    const b64 = body.data?.publicKey;
    if (!b64) {
      this.logger.warn(
        `Circle webhook: no publicKey in response (keyId=${keyId})`,
      );
      return null;
    }

    const key = createPublicKey({
      key: Buffer.from(b64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    this.keyCache.set(keyId, key);
    return key;
  }
}
