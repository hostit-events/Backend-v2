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
}

function setup(opts: {
  event: {
    id?: string;
    type: string | null;
    payload: unknown;
    processedAt?: Date | null;
  };
  bt?: { type: BlockchainTxType; ticketId: string | null } | null;
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

  const prisma = {
    webhookEvent: { findUnique: findWebhook, update: updateWebhook },
    blockchainTransaction: { findUnique: findBt },
  };

  const processor = new CircleWebhookProcessor(
    prisma as never,
    { reconcile } as never,
    { finalize } as never,
  );

  return { processor, findWebhook, updateWebhook, findBt, reconcile, finalize };
}

function job(webhookEventId = 'we-1'): Job<CircleWebhookJobData> {
  return {
    name: CIRCLE_WEBHOOK_JOB,
    data: { webhookEventId },
  } as Job<CircleWebhookJobData>;
}

function txPayload(state: string, id = 'tx-1', txHash = '0xabc') {
  return {
    notificationType: 'transactions.outbound',
    notification: { id, state, txHash },
  };
}

describe('CircleWebhookProcessor', () => {
  it('reconciles and finalizes a confirmed MINT', async () => {
    const m = setup({
      event: { type: 'transactions.outbound', payload: txPayload('CONFIRMED') },
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
      event: { type: 'transactions.outbound', payload: txPayload('FAILED') },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.reconcile).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ state: 'FAILED' }),
    );
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('is a no-op when no BlockchainTransaction matches (Phase 2 path)', async () => {
    const m = setup({
      event: { type: 'transactions.inbound', payload: txPayload('CONFIRMED') },
      bt: null,
    });

    await m.processor.process(job());

    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).toHaveBeenCalled(); // still marked processed
  });

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
        payload: txPayload('CONFIRMED'),
        processedAt: new Date('2026-01-01T00:00:00Z'),
      },
      bt: { type: BlockchainTxType.MINT, ticketId: 't-1' },
    });

    await m.processor.process(job());

    expect(m.findBt).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.updateWebhook).not.toHaveBeenCalled();
  });

  it('throws (for Bull retry) and records the error on failure', async () => {
    const m = setup({
      event: { type: 'transactions.outbound', payload: txPayload('CONFIRMED') },
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
