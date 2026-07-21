import {
  BlockchainTxStatus,
  BlockchainTxType,
  WalletCreationStatus,
} from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';
import { RefundProcessor } from './refund.processor';
import { FEE_TYPE_USDC } from './onchain-fees';
import { REFUND_TICKET_JOB, RefundTicketJobData } from './refund-queue.service';

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    status: 'CONFIRMED',
    tokenId: 42,
    ticketTypeId: 'tt-1',
    ticketType: { onChainTicketId: 5n },
    transaction: { provider: 'CRYPTO' },
    event: { id: 'e-1', chain: 'BASE-SEPOLIA' },
    buyer: {
      id: 'b-1',
      wallets: [
        {
          id: 'w-1',
          chain: 'BASE-SEPOLIA',
          address: '0xBUYER',
          circleWalletId: 'cw-buyer',
          creationStatus: WalletCreationStatus.CREATED,
        },
      ],
    },
    ...overrides,
  };
}

function setup(
  row: Record<string, unknown> | null,
  opts: {
    poll?: Record<string, unknown>;
    webhooksEnabled?: boolean;
  } = {},
) {
  const findUnique = jest.fn().mockResolvedValue(row);
  const update = jest.fn().mockResolvedValue({});
  const executeContract = jest
    .fn()
    .mockResolvedValue({ circleTransactionId: 'refund-1' });
  const pollUntilTerminal = jest
    .fn()
    .mockResolvedValue(opts.poll ?? { state: 'CONFIRMED', txHash: '0xhash' });
  const finalize = jest.fn().mockResolvedValue(true);
  const get = jest.fn().mockReturnValue(opts.webhooksEnabled ?? false);

  const proc = new RefundProcessor(
    { ticket: { findUnique }, blockchainTransaction: { update } } as never,
    { executeContract, pollUntilTerminal } as never,
    { finalize } as never,
    { get } as never,
  );
  return { proc, executeContract, pollUntilTerminal, finalize, update };
}

function job(): Job<RefundTicketJobData> {
  return {
    name: REFUND_TICKET_JOB,
    data: { ticketId: 't-1', eventId: 'e-1', blockchainTxId: 'bt-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as Job<RefundTicketJobData>;
}

describe('RefundProcessor', () => {
  it('crypto ticket: claimRefund signed by the buyer wallet, then finalize', async () => {
    const m = setup(ticketRow());

    await m.proc.process(job());

    expect(m.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'claimRefund',
        args: [5n, FEE_TYPE_USDC, 42n, '0xBUYER'],
        walletId: 'cw-buyer', // buyer signs — contract checks ownership
        txType: BlockchainTxType.REFUND,
        existingBlockchainTransactionId: 'bt-1',
        chain: 'BASE-SEPOLIA',
      }),
    );
    expect(m.finalize).toHaveBeenCalledWith('t-1', '0xhash');
  });

  it('webhook-authoritative: submits and returns without inline finalize', async () => {
    const m = setup(ticketRow(), { webhooksEnabled: true });

    await m.proc.process(job());

    expect(m.executeContract).toHaveBeenCalled();
    expect(m.pollUntilTerminal).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('already refunded: no-op, no on-chain call', async () => {
    const m = setup(ticketRow({ status: 'REFUNDED' }));

    await m.proc.process(job());

    expect(m.executeContract).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('non-crypto ticket: fails terminally without an on-chain call', async () => {
    const m = setup(ticketRow({ transaction: { provider: 'PAYSTACK' } }));

    await expect(m.proc.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.executeContract).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BlockchainTxStatus.FAILED }),
      }),
    );
  });

  it('never minted (no tokenId): fails terminally', async () => {
    const m = setup(ticketRow({ tokenId: null }));

    await expect(m.proc.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('terminal on-chain revert (window expired): no retry, marks FAILED', async () => {
    const m = setup(ticketRow(), {
      poll: { state: 'FAILED', errorReason: 'RefundPeriodExpired' },
    });

    await expect(m.proc.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bt-1' },
        data: expect.objectContaining({ status: BlockchainTxStatus.FAILED }),
      }),
    );
  });

  it('transient on-chain failure: retryable (plain error, not Unrecoverable)', async () => {
    const m = setup(ticketRow(), {
      poll: { state: 'FAILED', errorReason: 'network blip' },
    });

    await expect(m.proc.process(job())).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
    // Not final attempt → row stays PENDING for the next retry.
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BlockchainTxStatus.PENDING }),
      }),
    );
  });
});
