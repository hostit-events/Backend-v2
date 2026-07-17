import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletCreationStatus } from '@prisma/client';
import { CryptoCheckoutService } from './crypto-checkout.service';

// getChain reads from chains.config (env-driven). Stub it so the test
// doesn't depend on ACTIVE_CHAINS / RPC env being set.
jest.mock('../blockchain/chains.config', () => ({
  getChain: (id: string) => ({
    id,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  }),
}));

function makeConfig(rate = 1600, expiry = 30): ConfigService {
  return {
    getOrThrow: (key: string) => (key === 'crypto.usdcNgnRate' ? rate : expiry),
  } as unknown as ConfigService;
}

describe('CryptoCheckoutService', () => {
  describe('ngnToUsdc', () => {
    it('converts NGN to 6-dp USDC at the configured rate', () => {
      const svc = new CryptoCheckoutService({} as never, makeConfig(1600));
      expect(svc.ngnToUsdc(new Prisma.Decimal(5000)).toString()).toBe('3.125');
      expect(svc.ngnToUsdc(new Prisma.Decimal(1600)).toString()).toBe('1');
    });
  });

  describe('createDepositIntent', () => {
    const wallet = {
      circleWalletId: 'cw-1',
      address: '0xWALLET',
      creationStatus: WalletCreationStatus.CREATED,
    };

    function makePrisma(walletRow: unknown) {
      return {
        userWallet: { findFirst: jest.fn().mockResolvedValue(walletRow) },
        cryptoDeposit: { create: jest.fn().mockResolvedValue({}) },
      };
    }

    it('creates a CryptoDeposit and returns the deposit instruction', async () => {
      const prisma = makePrisma(wallet);
      const svc = new CryptoCheckoutService(prisma as never, makeConfig(1600));

      const intent = await svc.createDepositIntent({
        transactionId: 'txn-1',
        buyerId: 'buyer-1',
        chain: 'BASE-SEPOLIA',
        priceNgn: new Prisma.Decimal(5000),
        quantity: 1,
      });

      // Organizer-bears: face price is 3.125 USDC; ticketFee is backed out
      // of it and HostIT's 3% added back, landing at totalFee 3.124999 (a
      // 1-base-unit rounding delta from face) — what the buyer must send.
      expect(intent).toMatchObject({
        chain: 'BASE-SEPOLIA',
        address: '0xWALLET',
        amountUsdc: '3.124999',
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      });
      expect(intent.expiresAt).toBeInstanceOf(Date);

      const createArg = prisma.cryptoDeposit.create.mock.calls[0][0];
      expect(createArg.data).toMatchObject({
        transactionId: 'txn-1',
        walletId: 'cw-1',
        address: '0xWALLET',
        chain: 'BASE-SEPOLIA',
      });
      expect(createArg.data.amountUsdc.toString()).toBe('3.124999');
    });

    it('rejects when the buyer wallet is not yet provisioned', async () => {
      const prisma = makePrisma({
        ...wallet,
        creationStatus: WalletCreationStatus.PENDING,
      });
      const svc = new CryptoCheckoutService(prisma as never, makeConfig());

      await expect(
        svc.createDepositIntent({
          transactionId: 'txn-1',
          buyerId: 'buyer-1',
          chain: 'BASE-SEPOLIA',
          priceNgn: new Prisma.Decimal(5000),
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cryptoDeposit.create).not.toHaveBeenCalled();
    });

    it('rejects when the buyer has no wallet on the chain', async () => {
      const prisma = makePrisma(null);
      const svc = new CryptoCheckoutService(prisma as never, makeConfig());

      await expect(
        svc.createDepositIntent({
          transactionId: 'txn-1',
          buyerId: 'buyer-1',
          chain: 'BASE-SEPOLIA',
          priceNgn: new Prisma.Decimal(5000),
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
