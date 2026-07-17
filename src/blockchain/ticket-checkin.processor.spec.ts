import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import type { Job } from 'bullmq';
import { TicketCheckinProcessor } from './ticket-checkin.processor';
import {
  CHECKIN_TICKET_JOB,
  CheckinTicketJobData,
} from './checkin-queue.service';

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    tokenId: 42,
    ticketType: { id: 'tt-1', onChainTicketId: 7n },
    event: { id: 'e-1', chain: 'BASE-SEPOLIA' },
    buyer: {
      id: 'b-1',
      wallets: [{ chain: 'BASE-SEPOLIA', address: '0xabc' }],
    },
    ...overrides,
  };
}

function setup(
  opts: {
    ticket?: unknown;
    alreadyConfirmed?: { id: string } | null;
    webhooksEnabled?: boolean;
    poll?: { state: string; txHash?: string; errorReason?: string };
    scannerWallet?: { circleWalletId: string; address: string } | null;
  } = {},
) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(opts.ticket === undefined ? ticketRow() : opts.ticket);
  const findFirst = jest.fn().mockResolvedValue(opts.alreadyConfirmed ?? null);
  const userWalletFindFirst = jest
    .fn()
    .mockResolvedValue(
      opts.scannerWallet === undefined
        ? { circleWalletId: 'scw-1', address: '0xscanner' }
        : opts.scannerWallet,
    );
  const update = jest.fn().mockResolvedValue({});
  const executeContract = jest
    .fn()
    .mockResolvedValue({ circleTransactionId: 'ctx-1' });
  const pollUntilTerminal = jest
    .fn()
    .mockResolvedValue(opts.poll ?? { state: 'CONFIRMED', txHash: '0xhash' });
  const get = jest.fn().mockReturnValue(opts.webhooksEnabled ?? false);

  const prisma = {
    ticket: { findUnique },
    blockchainTransaction: { findFirst, update },
    userWallet: { findFirst: userWalletFindFirst },
  };
  const circle = { executeContract, pollUntilTerminal };
  const config = { get };

  const proc = new TicketCheckinProcessor(
    prisma as never,
    circle as never,
    config as never,
  );
  return {
    proc,
    findUnique,
    findFirst,
    userWalletFindFirst,
    update,
    executeContract,
    pollUntilTerminal,
  };
}

function job(
  data: CheckinTicketJobData = {
    ticketId: 't-1',
    eventId: 'e-1',
    blockchainTxId: 'bt-1',
    scannedBy: 'u-scanner',
  },
  attemptsMade = 0,
): Job<CheckinTicketJobData> {
  return {
    name: CHECKIN_TICKET_JOB,
    data,
    attemptsMade,
    opts: { attempts: 3 },
  } as Job<CheckinTicketJobData>;
}

describe('TicketCheckinProcessor', () => {
  it('submits checkIn with [onChainTicketId, owner, tokenId] and defers to the webhook', async () => {
    const m = setup({ webhooksEnabled: true });

    await m.proc.process(job());

    expect(m.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'checkIn',
        args: [7n, '0xabc', 42],
        chain: 'BASE-SEPOLIA',
        txType: BlockchainTxType.CHECKIN,
        ticketId: 't-1',
        existingBlockchainTransactionId: 'bt-1',
        // Signed by the scanner's wallet (holds the ticketAdmin role),
        // not the treasury.
        walletId: 'scw-1',
      }),
    );
    // Webhook authoritative → no polling.
    expect(m.pollUntilTerminal).not.toHaveBeenCalled();
  });

  it('throws when the job has no scannedBy (cannot resolve a signer)', async () => {
    const m = setup({ webhooksEnabled: true });

    await expect(
      m.proc.process(
        job({ ticketId: 't-1', eventId: 'e-1', blockchainTxId: 'bt-1' }),
      ),
    ).rejects.toThrow(/no scannedBy/);
    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('throws when the scanner has no ready wallet on the chain', async () => {
    const m = setup({ webhooksEnabled: true, scannerWallet: null });

    await expect(m.proc.process(job())).rejects.toThrow(/no ready wallet/);
    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('is idempotent: skips when a CONFIRMED check-in already exists', async () => {
    const m = setup({ alreadyConfirmed: { id: 'bt-old' } });

    await m.proc.process(job());

    expect(m.executeContract).not.toHaveBeenCalled();
  });

  it('polling fallback: a CONFIRMED tx completes cleanly', async () => {
    const m = setup({
      webhooksEnabled: false,
      poll: { state: 'CONFIRMED', txHash: '0xhash' },
    });

    await expect(m.proc.process(job())).resolves.toBeUndefined();
    expect(m.pollUntilTerminal).toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('polling fallback: a reverted tx is a conflict — no throw, no retry', async () => {
    const m = setup({
      webhooksEnabled: false,
      poll: { state: 'FAILED', errorReason: 'already checked in' },
    });

    // Resolves (does not throw) so Bull does not retry the revert.
    await expect(m.proc.process(job())).resolves.toBeUndefined();
    // Conflict path doesn't touch the row via the transient-error catch.
    expect(m.update).not.toHaveBeenCalled();
  });

  it('throws for an unminted ticket (no tokenId)', async () => {
    const m = setup({ ticket: ticketRow({ tokenId: null }) });
    await expect(m.proc.process(job())).rejects.toThrow(/never minted/);
  });

  it('marks the row and rethrows on a transient submit failure (Bull retry)', async () => {
    const m = setup({ webhooksEnabled: true });
    m.executeContract.mockRejectedValueOnce(new Error('circle 500'));

    await expect(m.proc.process(job())).rejects.toThrow('circle 500');
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bt-1' },
        data: expect.objectContaining({
          status: BlockchainTxStatus.PENDING, // attempt 1 of 3 → retry
          error: 'circle 500',
        }),
      }),
    );
  });

  it('marks the row FAILED on the final attempt', async () => {
    const m = setup({ webhooksEnabled: true });
    m.executeContract.mockRejectedValueOnce(new Error('circle 500'));

    await expect(
      m.proc.process(
        job(
          {
            ticketId: 't-1',
            eventId: 'e-1',
            blockchainTxId: 'bt-1',
            scannedBy: 'u-scanner',
          },
          2,
        ),
      ),
    ).rejects.toThrow('circle 500');
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BlockchainTxStatus.FAILED }),
      }),
    );
  });
});
