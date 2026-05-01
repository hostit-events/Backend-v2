import { BadRequestException } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { MonnifyProvider } from './providers/monnify.provider';
import { PaystackProvider } from './providers/paystack.provider';

function makeService(): PaymentsService {
  // Concrete provider classes aren't exercised by these tests (no
  // network calls). Cast through unknown so we can satisfy the
  // constructor without mocking Paystack/Monnify behaviour.
  const stub = {} as unknown;
  return new PaymentsService(stub as PaystackProvider, stub as MonnifyProvider);
}

describe('PaymentsService — country-aware methods', () => {
  describe('listMethods', () => {
    it('returns Paystack + Monnify + crypto for an NG event with crypto on', () => {
      const list = makeService().listMethods({
        country: 'NG',
        currency: 'NGN',
        acceptsCrypto: true,
      });

      expect(list.country).toBe('NG');
      expect(list.currency).toBe('NGN');
      expect(list.methods).toHaveLength(3);

      const fiat = list.methods.filter((m) => m.type === 'fiat');
      expect(fiat).toHaveLength(2);
      expect(fiat.map((m) => 'provider' in m && m.provider)).toEqual([
        PaymentProvider.PAYSTACK,
        PaymentProvider.MONNIFY,
      ]);

      const crypto = list.methods.find((m) => m.type === 'crypto');
      expect(crypto).toBeDefined();
      if (crypto?.type === 'crypto') {
        expect(crypto.tokens).toContain('USDC');
      }
    });

    it('omits crypto when acceptsCrypto is false', () => {
      const list = makeService().listMethods({
        country: 'NG',
        currency: 'NGN',
        acceptsCrypto: false,
      });
      expect(list.methods.every((m) => m.type === 'fiat')).toBe(true);
      expect(list.methods).toHaveLength(2);
    });

    it('returns crypto only for an unknown country with crypto on', () => {
      const list = makeService().listMethods({
        country: 'US',
        currency: 'USD',
        acceptsCrypto: true,
      });
      expect(list.methods).toHaveLength(1);
      expect(list.methods[0].type).toBe('crypto');
    });

    it('returns an empty methods list for unknown country with crypto off', () => {
      const list = makeService().listMethods({
        country: 'US',
        currency: 'USD',
        acceptsCrypto: false,
      });
      expect(list.methods).toHaveLength(0);
    });

    it('flags Paystack as the default for NG', () => {
      const list = makeService().listMethods({
        country: 'NG',
        currency: 'NGN',
        acceptsCrypto: true,
      });
      const paystack = list.methods.find(
        (m) => m.type === 'fiat' && m.provider === PaymentProvider.PAYSTACK,
      );
      expect(paystack && 'default' in paystack && paystack.default).toBe(true);
    });
  });

  describe('assertEligible', () => {
    const ngEvent = {
      country: 'NG',
      currency: 'NGN',
      acceptsCrypto: true,
    };

    it('passes for a country-eligible fiat provider', () => {
      expect(() =>
        makeService().assertEligible(ngEvent, PaymentProvider.PAYSTACK),
      ).not.toThrow();
      expect(() =>
        makeService().assertEligible(ngEvent, PaymentProvider.MONNIFY),
      ).not.toThrow();
    });

    it('rejects a fiat provider that does not serve the event country', () => {
      const usEvent = {
        country: 'US',
        currency: 'USD',
        acceptsCrypto: true,
      };
      expect(() =>
        makeService().assertEligible(usEvent, PaymentProvider.PAYSTACK),
      ).toThrow(BadRequestException);
    });

    it('passes crypto when acceptsCrypto=true', () => {
      expect(() =>
        makeService().assertEligible(ngEvent, PaymentProvider.CRYPTO),
      ).not.toThrow();
    });

    it('rejects crypto when acceptsCrypto=false', () => {
      const noCrypto = { ...ngEvent, acceptsCrypto: false };
      expect(() =>
        makeService().assertEligible(noCrypto, PaymentProvider.CRYPTO),
      ).toThrow(BadRequestException);
      expect(() =>
        makeService().assertEligible(noCrypto, PaymentProvider.BLOCKRADAR),
      ).toThrow(BadRequestException);
    });
  });
});
