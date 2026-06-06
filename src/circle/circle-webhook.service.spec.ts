import { ConfigService } from '@nestjs/config';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { CircleWebhookService } from './circle-webhook.service';

/** Sign a body with the test private key, returning a base64 DER ECDSA sig. */
function sign(body: string, privateKey: KeyObject): string {
  return createSign('SHA256').update(body, 'utf8').sign(privateKey, 'base64');
}

function makeConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      key === 'circle.apiBaseUrl' ? 'https://api.circle.com' : 'TEST_API_KEY',
  } as unknown as ConfigService;
}

describe('CircleWebhookService.verify', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const publicKeyDerB64 = publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');

  const keyId = 'key-1';
  const payload = JSON.stringify({
    notificationType: 'transactions.outbound',
    notification: { id: 'tx-1', state: 'CONFIRMED' },
  });

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { publicKey: publicKeyDerB64, algorithm: 'ECDSA_SHA_256' },
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns true for a valid signature', async () => {
    const service = new CircleWebhookService(makeConfig());
    const signature = sign(payload, privateKey);

    await expect(service.verify(payload, signature, keyId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer TEST_API_KEY',
        }),
      }),
    );
  });

  it('returns false when the body is tampered with', async () => {
    const service = new CircleWebhookService(makeConfig());
    const signature = sign(payload, privateKey);

    const tampered = payload.replace('CONFIRMED', 'FAILED');
    await expect(service.verify(tampered, signature, keyId)).resolves.toBe(
      false,
    );
  });

  it('returns false when the signature is from a different key', async () => {
    const service = new CircleWebhookService(makeConfig());
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const forged = sign(payload, other.privateKey);

    await expect(service.verify(payload, forged, keyId)).resolves.toBe(false);
  });

  it('returns false when signature or key id header is missing', async () => {
    const service = new CircleWebhookService(makeConfig());
    const signature = sign(payload, privateKey);

    await expect(service.verify(payload, undefined, keyId)).resolves.toBe(
      false,
    );
    await expect(service.verify(payload, signature, undefined)).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when the public key fetch fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const service = new CircleWebhookService(makeConfig());
    const signature = sign(payload, privateKey);

    await expect(service.verify(payload, signature, keyId)).resolves.toBe(
      false,
    );
  });

  it('caches the public key across calls (one fetch per keyId)', async () => {
    const service = new CircleWebhookService(makeConfig());
    const signature = sign(payload, privateKey);

    await service.verify(payload, signature, keyId);
    await service.verify(payload, signature, keyId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
