import {
  BlockchainTxStatus,
  BlockchainTxType,
  WalletCreationStatus,
} from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';
import { PayoutProcessor } from './payout.processor';
import { FEE_TYPE_USDC } from './onchain-fees';
import { PAYOUT_TICKET_JOB, PayoutTicketJobData } from './payout-queue.service';

function ticketTypeRow(overrides: Record<string, unknown> = {}) {
  return {
    onChainTicketId: 9n,
    event: { id: 'e-1', chain: 'BASE-SEPOLIA', organizerId: 'org-1' },
    ...overrides,
  };
}

function setup(
  row: Record<string, unknown> | null,
  opts: {
    balance?: bigint;
    poll?: Record<string, unknown>;
    webhooksEnabled?: boolean;
    wallet?: Record<string, unknown> | null;
  } = {},
) {
  const findTicketType = jest.fn().mockResolvedValue(row);
  const findWallet = jest.fn().mockResolvedValue(
    opts.wallet === undefined
      ? {
          circleWalletId: 'cw-org',
          address: '0xORG',
          creationStatus: WalletCreationStatus.CREATED,
        }
      : opts.wallet,
  );
  const update = jest.fn().mockResolvedValue({});
  const getTicketBalance = jest
    .fn()
    .mockResolvedValue(opts.balance ?? 1_000_000n);
  const executeContract = jest
    .fn()
    .mockResolvedValue({ circleTransactionId: 'payout-1' });
  const pollUntilTerminal = jest
    .fn()
    .mockResolvedValue(opts.poll ?? { state: 'CONFIRMED', txHash: '0xhash' });
  const finalize = jest.fn().mockResolvedValue(undefined);
  const get = jest.fn().mockReturnValue(opts.webhooksEnabled ?? false);

  const proc = new PayoutProcessor(
    {
      ticketType: { findUnique: findTicketType },
      userWallet: { findFirst: findWallet },
      blockchainTransaction: { update },
    } as never,
    { executeContract, pollUntilTerminal } as never,
    { getTicketBalance } as never,
    { finalize } as never,
    { get } as never,
  );
  return {
    proc,
    executeContract,
    pollUntilTerminal,
    finalize,
    update,
    getTicketBalance,
  };
}

function job(): Job<PayoutTicketJobData> {
  return {
    name: PAYOUT_TICKET_JOB,
    data: { ticketTypeId: 'tt-1', eventId: 'e-1', blockchainTxId: 'bt-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as Job<PayoutTicketJobData>;
}

describe('PayoutProcessor', () => {
  it('withdraws escrow to the organizer wallet, signed by the organizer', async () => {
    const m = setup(ticketTypeRow());

    await m.proc.process(job());

    expect(m.getTicketBalance).toHaveBeenCalledWith(
      'BASE-SEPOLIA',
      9n,
      FEE_TYPE_USDC,
    );
    expect(m.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'withdrawTicketBalance',
        args: [9n, FEE_TYPE_USDC, '0xORG'],
        walletId: 'cw-org', // organizer signs — they own the balance
        txType: BlockchainTxType.WITHDRAW,
        existingBlockchainTransactionId: 'bt-1',
        chain: 'BASE-SEPOLIA',
      }),
    );
    expect(m.finalize).toHaveBeenCalledWith(
      { eventId: 'e-1', chain: 'BASE-SEPOLIA' },
      '0xhash',
    );
  });

  it('zero escrow balance: no-op, closes the audit row as CONFIRMED', async () => {
    const m = setup(ticketTypeRow(), { balance: 0n });

    await m.proc.process(job());

    expect(m.executeContract).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bt-1' },
        data: { status: BlockchainTxStatus.CONFIRMED },
      }),
    );
  });

  it('webhook-authoritative: submits and returns without inline finalize', async () => {
    const m = setup(ticketTypeRow(), { webhooksEnabled: true });

    await m.proc.process(job());

    expect(m.executeContract).toHaveBeenCalled();
    expect(m.pollUntilTerminal).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('unpublished ticket type (no onChainTicketId): fails terminally', async () => {
    const m = setup(ticketTypeRow({ onChainTicketId: null }));

    await expect(m.proc.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('organizer wallet not ready: retryable', async () => {
    const m = setup(ticketTypeRow(), { wallet: null });

    await expect(m.proc.process(job())).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('terminal revert (insufficient balance): no retry, marks FAILED', async () => {
    const m = setup(ticketTypeRow(), {
      poll: { state: 'FAILED', errorReason: 'InsufficientWithdrawBalance' },
    });

    await expect(m.proc.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BlockchainTxStatus.FAILED }),
      }),
    );
  });

  it('withdraw period not reached: retryable (not Unrecoverable)', async () => {
    const m = setup(ticketTypeRow(), {
      poll: { state: 'FAILED', errorReason: 'WithdrawPeriodNotReached' },
    });

    await expect(m.proc.process(job())).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BlockchainTxStatus.PENDING }),
      }),
    );
  });
});
