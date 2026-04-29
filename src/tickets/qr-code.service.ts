import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as QRCode from 'qrcode';

/**
 * Signed payload encoded into the QR. The chain + ticketId + tokenId
 * together identify the on-chain NFT; owner pins ownership at issue
 * time. Scanners verify the signature, then re-check live ownership +
 * check-in status against the chain via BlockchainReadService.
 */
export interface QrPayload {
  chain: string;
  ticketId: string; // bigint serialized as string
  tokenId: string; // bigint serialized as string
  owner: string; // wallet address that owned the NFT at issue time
  iat: number; // unix seconds
  exp: number; // unix seconds — soft expiry; scanners may reject expired
}

export interface IssuedQr {
  /** The compact token (`htv1.<payload>.<sig>`) — encode this into the QR. */
  token: string;
  /** PNG data URL ready to embed in an email/img tag. */
  dataUrl: string;
}

export type VerifyResult =
  | { valid: true; payload: QrPayload; expired: boolean }
  | { valid: false; reason: string };

const VERSION = 'htv1';

/**
 * Issues and verifies signed ticket QR codes.
 *
 * Format: `htv1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(...))>`.
 *
 * The signature only proves "this payload was issued by HostIT." The
 * caller (e.g. scanner) is still responsible for cross-checking against
 * the chain via BlockchainReadService — the QR is a credential, not a
 * source of truth.
 */
@Injectable()
export class QrCodeService implements OnModuleInit {
  private readonly logger = new Logger(QrCodeService.name);
  private secret!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.getOrThrow<string>('TICKET_QR_SIGNING_SECRET');
    this.secret = Buffer.from(raw, 'utf8');
    if (this.secret.length < 32) {
      throw new Error(
        'TICKET_QR_SIGNING_SECRET must be at least 32 bytes (e.g. `openssl rand -hex 32`)',
      );
    }
  }

  /**
   * Sign a payload and produce both the encoded token and a PNG data
   * URL ready for delivery channels.
   */
  async issue(
    input: Omit<QrPayload, 'iat' | 'exp'> & { ttlSeconds?: number },
  ): Promise<IssuedQr> {
    const now = Math.floor(Date.now() / 1000);
    const payload: QrPayload = {
      chain: input.chain,
      ticketId: input.ticketId,
      tokenId: input.tokenId,
      owner: input.owner.toLowerCase(),
      iat: now,
      exp: now + (input.ttlSeconds ?? 60 * 60 * 24 * 365), // default 1 year
    };

    const token = this.encode(payload);
    const dataUrl = await QRCode.toDataURL(token, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    return { token, dataUrl };
  }

  /**
   * Verify a token's signature and decode the payload. Returns
   * `valid: false` for any tampering, format error, or signature
   * mismatch. Expired tokens still verify (`valid: true, expired: true`)
   * — caller decides whether to honour them.
   */
  verify(token: string): VerifyResult {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'empty_token' };
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'malformed' };
    }
    const [version, payloadB64, sigB64] = parts;
    if (version !== VERSION) {
      return { valid: false, reason: `unsupported_version:${version}` };
    }

    const expected = this.sign(`${version}.${payloadB64}`);
    let provided: Buffer;
    try {
      provided = Buffer.from(sigB64, 'base64url');
    } catch {
      return { valid: false, reason: 'bad_signature_encoding' };
    }
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return { valid: false, reason: 'signature_mismatch' };
    }

    let payload: QrPayload;
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as QrPayload;
    } catch {
      return { valid: false, reason: 'bad_payload_encoding' };
    }

    const required: Array<keyof QrPayload> = [
      'chain',
      'ticketId',
      'tokenId',
      'owner',
      'iat',
      'exp',
    ];
    for (const k of required) {
      if (payload[k] === undefined || payload[k] === null) {
        return { valid: false, reason: `missing_field:${k}` };
      }
    }

    return {
      valid: true,
      payload,
      expired: Math.floor(Date.now() / 1000) > payload.exp,
    };
  }

  /** Throw-on-invalid wrapper for controllers that want to short-circuit. */
  verifyOrThrow(token: string): { payload: QrPayload; expired: boolean } {
    const r = this.verify(token);
    if (!r.valid) {
      throw new BadRequestException(`Invalid ticket QR: ${r.reason}`);
    }
    return { payload: r.payload, expired: r.expired };
  }

  // ---------- internals ----------

  private encode(payload: QrPayload): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const sig = this.sign(`${VERSION}.${payloadB64}`);
    return `${VERSION}.${payloadB64}.${sig.toString('base64url')}`;
  }

  private sign(input: string): Buffer {
    return createHmac('sha256', this.secret).update(input).digest();
  }
}
