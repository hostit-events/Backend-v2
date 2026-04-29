import { ConfigService } from '@nestjs/config';
import { QrCodeService } from './qr-code.service';

const VALID_SECRET = 'a'.repeat(32);

function makeService(secret: string = VALID_SECRET): QrCodeService {
  const config = {
    getOrThrow: <T>(key: string): T => {
      if (key === 'TICKET_QR_SIGNING_SECRET') return secret as unknown as T;
      throw new Error(`unexpected key: ${key}`);
    },
  } as unknown as ConfigService;
  const svc = new QrCodeService(config);
  svc.onModuleInit();
  return svc;
}

describe('QrCodeService', () => {
  it('issues a token + PNG data URL', async () => {
    const svc = makeService();
    const out = await svc.issue({
      chain: 'BASE-SEPOLIA',
      ticketId: '2',
      tokenId: '1',
      owner: '0x6ab77231f883f78002e37fe9632e0b585d370731',
    });
    expect(out.token.startsWith('htv1.')).toBe(true);
    expect(out.token.split('.')).toHaveLength(3);
    expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('round-trips: a freshly issued token verifies and decodes back', async () => {
    const svc = makeService();
    const owner = '0x6ab77231F883F78002E37Fe9632E0B585D370731'; // mixed case
    const { token } = await svc.issue({
      chain: 'BASE-SEPOLIA',
      ticketId: '2',
      tokenId: '1',
      owner,
    });

    const r = svc.verify(token);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.payload.chain).toBe('BASE-SEPOLIA');
    expect(r.payload.ticketId).toBe('2');
    expect(r.payload.tokenId).toBe('1');
    // owner is normalized to lowercase at issue time
    expect(r.payload.owner).toBe(owner.toLowerCase());
    expect(r.expired).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const issuer = makeService('a'.repeat(32));
    const verifier = makeService('b'.repeat(32));
    const { token } = await issuer.issue({
      chain: 'BASE-SEPOLIA',
      ticketId: '1',
      tokenId: '1',
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const r = verifier.verify(token);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.reason).toBe('signature_mismatch');
  });

  it('rejects a token with a tampered payload', async () => {
    const svc = makeService();
    const { token } = await svc.issue({
      chain: 'BASE-SEPOLIA',
      ticketId: '1',
      tokenId: '1',
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const [v, , s] = token.split('.');
    // Substitute a different payload but keep the original signature
    const otherPayload = Buffer.from(
      JSON.stringify({
        chain: 'BASE-SEPOLIA',
        ticketId: '999',
        tokenId: '999',
        owner: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        iat: 0,
        exp: 9999999999,
      }),
      'utf8',
    ).toString('base64url');
    const tampered = `${v}.${otherPayload}.${s}`;

    const r = svc.verify(tampered);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.reason).toBe('signature_mismatch');
  });

  it('rejects malformed and unsupported-version tokens', () => {
    const svc = makeService();
    expect(svc.verify('').valid).toBe(false);
    expect(svc.verify('garbage').valid).toBe(false);
    expect(svc.verify('a.b').valid).toBe(false);

    const r = svc.verify('htv9.payload.sig');
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.reason).toBe('unsupported_version:htv9');
  });

  it('flags expired tokens but still returns the payload', async () => {
    const svc = makeService();
    const { token } = await svc.issue({
      chain: 'BASE-SEPOLIA',
      ticketId: '1',
      tokenId: '1',
      owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ttlSeconds: -1, // already expired
    });
    const r = svc.verify(token);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.expired).toBe(true);
  });

  it('refuses to start with a short signing secret', () => {
    expect(() => makeService('short')).toThrow(/at least 32 bytes/i);
  });
});
