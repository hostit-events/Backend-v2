import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletCreationStatus } from '@prisma/client';
import { CircleService } from '../circle/circle.service';
import { CryptoCheckoutService } from './crypto-checkout.service';

const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// getChain reads from chains.config (env-driven). Stub it so the test
// doesn't depend on ACTIVE_CHAINS / RPC env being set.
jest.mock('../blockchain/chains.config', () => ({
  getChain: (id: string) => ({ id, usdcAddress: USDC_ADDRESS }),
}));

function makeConfig(rate = 1600, expiry = 30): ConfigService {
  return {
    getOrThrow: (key: string) => (key === 'crypto.usdcNgnRate' ? rate : expiry),
  } as unknown as ConfigService;
}

// `null` → no USDC balance; a string → that USDC balance on the wallet.
function makeCircle(usdcAmount: string | null): CircleService {
  return {
    client: {
      getWalletTokenBalance: jest.fn().mockResolvedValue({
        data: {
          tokenBalances:
            usdcAmount === null
              ? []
              : [{ token: { tokenAddress: USDC_ADDRESS }, amount: usdcAmount }],
        },
      }),
    },
  } as unknown as CircleService;
}

describe('CryptoCheckoutService', () => {
  describe('ngnToUsdc', () => {
    it('converts NGN to 6-dp USDC at the configured rate', () => {
      const svc = new CryptoCheckoutService(
        {} as never,
        makeConfig(1600),
        makeCircle('0'),
      );
      expect(svc.ngnToUsdc(new Prisma.Decimal(5000)).toString()).toBe('3.125');
      expect(svc.ngnToUsdc(new Prisma.Decimal(1600)).toString()).toBe('1');
    });
  });

  describe('prepareCrypto', () => {
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

    const input = {
      transactionId: 'txn-1',
      buyerId: 'buyer-1',
      chain: 'BASE-SEPOLIA',
      priceNgn: new Prisma.Decimal(5000),
      quantity: 1,
    };

    it('pays from balance (no deposit) when the wallet already holds enough', async () => {
      const prisma = makePrisma(wallet);
      const svc = new CryptoCheckoutService(
        prisma as never,
        makeConfig(1600),
        makeCircle('5'),
      );

      const plan = await svc.prepareCrypto(input);

      expect(plan).toMatchObject({
        mode: 'balance',
        requiredUsdc: '3.124999', // organizer-bears total for a 5000 NGN ticket
        walletBalanceUsdc: '5.000000',
      });
      expect(prisma.cryptoDeposit.create).not.toHaveBeenCalled();
    });

    it('returns a shortfall deposit when the balance is insufficient', async () => {
      const prisma = makePrisma(wallet);
      const svc = new CryptoCheckoutService(
        prisma as never,
        makeConfig(1600),
        makeCircle('1'),
      );

      const plan = await svc.prepareCrypto(input);

      expect(plan.mode).toBe('deposit');
      if (plan.mode === 'deposit') {
        // 3.124999 required - 1 held = 2.124999 to top up.
        expect(plan.deposit).toMatchObject({
          address: '0xWALLET',
          amountUsdc: '2.124999',
          usdcAddress: USDC_ADDRESS,
          decimals: 6,
        });
        expect(plan.walletBalanceUsdc).toBe('1.000000');
      }
      const createArg = prisma.cryptoDeposit.create.mock.calls[0][0];
      expect(createArg.data.amountUsdc.toString()).toBe('2.124999');
    });

    it('deposits the full amount when the wallet holds no USDC', async () => {
      const prisma = makePrisma(wallet);
      const svc = new CryptoCheckoutService(
        prisma as never,
        makeConfig(1600),
        makeCircle(null),
      );

      const plan = await svc.prepareCrypto(input);

      expect(plan.mode).toBe('deposit');
      if (plan.mode === 'deposit') {
        expect(plan.deposit.amountUsdc).toBe('3.124999');
      }
    });

    it('rejects when the buyer wallet is not yet provisioned', async () => {
      const prisma = makePrisma({
        ...wallet,
        creationStatus: WalletCreationStatus.PENDING,
      });
      const svc = new CryptoCheckoutService(
        prisma as never,
        makeConfig(),
        makeCircle('0'),
      );

      await expect(svc.prepareCrypto(input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.cryptoDeposit.create).not.toHaveBeenCalled();
    });

    it('rejects when the buyer has no wallet on the chain', async () => {
      const prisma = makePrisma(null);
      const svc = new CryptoCheckoutService(
        prisma as never,
        makeConfig(),
        makeCircle('0'),
      );

      await expect(svc.prepareCrypto(input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
