import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import {
  CheckinQueueService,
  CHECKIN_TICKET_JOB,
} from './checkin-queue.service';

function setup() {
  const create = jest.fn().mockResolvedValue({ id: 'bt-1' });
  const add = jest.fn().mockResolvedValue(undefined);
  const prisma = { blockchainTransaction: { create } };
  const queue = { add };
  const svc = new CheckinQueueService(prisma as never, queue as never);
  return { svc, create, add };
}

describe('CheckinQueueService', () => {
  it('writes a PENDING CHECKIN audit row then enqueues the job', async () => {
    const { svc, create, add } = setup();

    await svc.enqueueCheckin('t-1', 'e-1', {
      scannedBy: 'u-1',
      scannedAt: '2026-06-14T10:00:00Z',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: 't-1',
          eventId: 'e-1',
          type: BlockchainTxType.CHECKIN,
          status: BlockchainTxStatus.PENDING,
        }),
      }),
    );
    expect(add).toHaveBeenCalledWith(
      CHECKIN_TICKET_JOB,
      expect.objectContaining({
        ticketId: 't-1',
        eventId: 'e-1',
        blockchainTxId: 'bt-1',
        scannedBy: 'u-1',
        scannedAt: '2026-06-14T10:00:00Z',
      }),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('works without scanner metadata', async () => {
    const { svc, add } = setup();
    await svc.enqueueCheckin('t-2', 'e-2');
    expect(add).toHaveBeenCalledWith(
      CHECKIN_TICKET_JOB,
      expect.objectContaining({ ticketId: 't-2', blockchainTxId: 'bt-1' }),
      expect.anything(),
    );
  });
});
