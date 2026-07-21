import { BlockchainTxType } from '@prisma/client';
import type { Job } from 'bullmq';
import { CircleWebhookProcessor } from './circle-webhook.processor';
import {
  CIRCLE_WEBHOOK_JOB,
  CircleWebhookJobData,
} from './circle-webhook.queue';

interface Mocks {
  processor: CircleWebhookProcessor;
  findWebhook: jest.Mock;
  updateWebhook: jest.Mock;
  findBt: jest.Mock;
  reconcile: jest.Mock;
  finalize: jest.Mock;
  enqueueMint: jest.Mock;
  findDeposit: jest.Mock;
  updateDeposit: jest.Mock;
  findTxn: jest.Mock;
  updateTxn: jest.Mock;
  findTickets: jest.Mock;
}

function setup(opts: {
  event: {
    id?: string;
    type: string | null;
    payload: unknown;
    processedAt?: Date | null;
  };
  bt?: { type: BlockchainTxType; ticketId: string | null } | null;
  deposit?: { id: string; transactionId: string } | null;
  txn?: { id: string; status: string } | null;
  tickets?: { id: string; eventId: string }[];
}): Mocks {
  const findWebhook = jest.fn().mockResolvedValue({
    id: opts.event.id ?? 'we-1',
    type: opts.event.type,
    payload: opts.event.payload,
    processedAt: opts.event.processedAt ?? null,
  });
  const updateWebhook = jest.fn().mockResolvedValue({});
  const findBt = jest.fn().mockResolvedValue(opts.bt ?? null);
  const reconcile = jest.fn().mockResolvedValue(undefined);
  const finalize = jest.fn().mockResolvedValue(true);
  const refundFinalize = jest.fn().mockResolvedValue(true);
  const enqueueMint = jest.fn().mockResolvedValue(undefined);

  const findDeposit = jest.fn().mockResolvedValue(opts.deposit ?? null);
  const updateDeposit = jest.fn().mockResolvedValue({});
  const findTxn = jest.fn().mockResolvedValue(opts.txn ?? null);
  const updateTxn = jest.fn().mockResolvedValue({});
  const findTickets = jest.fn().mockResolvedValue(opts.tickets ?? []);

  const db = {
    cryptoDeposit: { update: updateDeposit },
    transaction: { findUnique: findTxn, update: updateTxn },
    ticket: { findMany: findTickets },
  };

  const prisma = {
    webhookEvent: { findUnique: findWebhook, update: updateWebhook },
    blockchainTransaction: { findUnique: findBt },
    cryptoDeposit: { findFirst: findDeposit },
    $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
  };

  const processor = new CircleWebhookProcessor(
    prisma as never,
    { reconcile } as never,
    { finalize } as never,
    { finalize: refundFinalize } as never,
    { enqueueMint } as never,
  );

  return {
    processor,
    findWebhook,
    updateWebhook,
    findBt,
    reconcile,
    finalize,
    refundFinalize,
    enqueueMint,
    findDeposit,
    updateDeposit,
    findTxn,
    updateTxn,
    findTickets,
  };
}

function job(webhookEventId = 'we-1'): Job<CircleWebhookJobData> {
  return {
    name: CIRCLE_WEBHOOK_JOB,
    data: { webhookEventId },
  } as Job<CircleWebhookJobData>;
}

function outboundPayload(state: string, id = 'tx-1', txHash = '0xabc') {
  return {
    notificationType: 'transactions.outbound',
    notification: { id, state, txHash },
  };
}

function inboundPayload(opts: {
  state: string;
  walletId?: string;
  amount?: string;
  id?: string;
  txHash?: string;
}) {
  return {
    notificationType: 'transactions.inbound',
    notification: {
      id: opts.id ?? 'in-1',
      state: opts.state,
      walletId: opts.walletId ?? 'w-1',
      amounts: opts.amount !== undefined ? [opts.amount] : undefined,
      txHash: opts.txHash ?? '0xdeposit',
    },
  };
}

describe('CircleWebhookProcessor — contract executions', () => {
  it('reconciles and finalizes a confirmed MINT', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('CONFIRMED'),
      },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.reconcile).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ state: 'CONFIRMED', txHash: '0xabc' }),
    );
    expect(m.finalize).toHaveBeenCalledWith('t-1', '0xabc');
    expect(m.updateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    );
  });

  it('reconciles but does not finalize a FAILED MINT', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('FAILED'),
      },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.reconcile).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ state: 'FAILED' }),
    );
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('is a no-op when no BlockchainTransaction matches', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('CONFIRMED'),
      },
      bt: null,
    });

    await m.processor.process(job());

    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalled();
  });

  it('reconciles a confirmed CHECKIN without finalizing (audit record)', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('CONFIRMED'),
      },
      bt: { type: BlockchainTxType.CHECKIN, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.reconcile).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ state: 'CONFIRMED' }),
    );
    // checkIn confirmation is just an audit record — no mint finalizer.
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    );
  });

  it('reconciles a FAILED CHECKIN as a conflict (no throw, marked processed)', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('FAILED'),
      },
      bt: { type: BlockchainTxType.CHECKIN, ticketId: 't-1' },
    });

    await expect(m.processor.process(job())).resolves.toBeUndefined();
    expect(m.reconcile).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ state: 'FAILED' }),
    );
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalled();
  });
});

describe('CircleWebhookProcessor — inbound crypto deposits', () => {
  it('settles the transaction and enqueues mints on a matched deposit', async () => {
    const m = setup({
      event: {
        type: 'transactions.inbound',
        payload: inboundPayload({
          state: 'COMPLETE',
          walletId: 'w-1',
          amount: '3.125',
        }),
      },
      deposit: { id: 'dep-1', transactionId: 'txn-1' },
      txn: { id: 'txn-1', status: 'PENDING' },
      tickets: [
        { id: 't-1', eventId: 'e-1' },
        { id: 't-2', eventId: 'e-1' },
      ],
    });

    await m.processor.process(job());

    expect(m.updateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dep-1' },
        data: expect.objectContaining({ status: 'CONFIRMED' }),
      }),
    );
    expect(m.updateTxn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCESS' }),
      }),
    );
    expect(m.enqueueMint).toHaveBeenCalledTimes(2);
    expect(m.enqueueMint).toHaveBeenCalledWith('t-1', 'e-1');
  });

  it('ignores an inbound transfer matching no pending deposit', async () => {
    const m = setup({
      event: {
        type: 'transactions.inbound',
        payload: inboundPayload({
          state: 'COMPLETE',
          walletId: 'w-x',
          amount: '5',
        }),
      },
      deposit: null,
    });

    await m.processor.process(job());

    expect(m.updateDeposit).not.toHaveBeenCalled();
    expect(m.enqueueMint).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalled(); // still marked processed
  });

  it('does not re-settle when the transaction is already SUCCESS (replay)', async () => {
    const m = setup({
      event: {
        type: 'transactions.inbound',
        payload: inboundPayload({
          state: 'COMPLETE',
          walletId: 'w-1',
          amount: '3.125',
        }),
      },
      deposit: { id: 'dep-1', transactionId: 'txn-1' },
      txn: { id: 'txn-1', status: 'SUCCESS' },
    });

    await m.processor.process(job());

    expect(m.updateTxn).not.toHaveBeenCalled();
    expect(m.enqueueMint).not.toHaveBeenCalled();
  });

  it('ignores a non-terminal inbound transfer', async () => {
    const m = setup({
      event: {
        type: 'transactions.inbound',
        payload: inboundPayload({
          state: 'SENT',
          walletId: 'w-1',
          amount: '3.125',
        }),
      },
      deposit: { id: 'dep-1', transactionId: 'txn-1' },
    });

    await m.processor.process(job());

    expect(m.findDeposit).not.toHaveBeenCalled();
    expect(m.enqueueMint).not.toHaveBeenCalled();
  });
});

describe('CircleWebhookProcessor — general', () => {
  it('ignores webhooks.test without touching the chain', async () => {
    const m = setup({
      event: {
        type: 'webhooks.test',
        payload: { notification: { hello: 'world' } },
      },
    });

    await m.processor.process(job());

    expect(m.findBt).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalled();
  });

  it('skips an already-processed event (replay-safe)', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('CONFIRMED'),
        processedAt: new Date('2026-01-01T00:00:00Z'),
      },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.findBt).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.updateWebhook).not.toHaveBeenCalled();
  });

  it('throws (for Bull retry) and records the error on failure', async () => {
    const m = setup({
      event: {
        type: 'transactions.outbound',
        payload: outboundPayload('CONFIRMED'),
      },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });
    m.finalize.mockRejectedValueOnce(new Error('receipt not found'));

    await expect(m.processor.process(job())).rejects.toThrow(
      'receipt not found',
    );
    expect(m.updateWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'receipt not found' }),
      }),
    );
  });
});
