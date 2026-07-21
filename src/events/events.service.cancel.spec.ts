import { BadRequestException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { EventsService } from './events.service';

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e-1',
    name: 'My Event',
    slug: 'my-event',
    organizerId: 'org-1',
    status: EventStatus.PUBLISHED,
    isRefundable: true,
    ticketTypes: [{ soldCount: 3 }],
    ...overrides,
  };
}

function setup(row: Record<string, unknown>, cryptoTicketIds: string[] = []) {
  const findUnique = jest.fn().mockResolvedValue(row);
  const update = jest
    .fn()
    .mockResolvedValue({ ...row, status: EventStatus.CANCELLED });
  const deleteMany = jest.fn().mockResolvedValue({});
  const findMany = jest
    .fn()
    .mockResolvedValue(cryptoTicketIds.map((id) => ({ id })));
  const enqueueRefund = jest.fn().mockResolvedValue(undefined);

  const service = new EventsService(
    {
      event: { findUnique, update },
      ticketType: { deleteMany },
      ticket: { findMany },
    } as never,
    {} as never, // eventPublishQueue
    {} as never, // notifications
    { get: jest.fn() } as never, // configService
    { enqueueRefund } as never,
  );
  return { service, enqueueRefund, findMany, update };
}

describe('EventsService.cancel — refunds', () => {
  it('enqueues one on-chain refund per confirmed crypto ticket', async () => {
    const { service, enqueueRefund, findMany } = setup(eventRow(), [
      't-1',
      't-2',
    ]);

    await service.cancel('e-1', 'org-1');

    // Query is scoped to confirmed, minted, crypto tickets on this event.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: 'e-1',
          tokenId: { not: null },
        }),
      }),
    );
    expect(enqueueRefund).toHaveBeenCalledTimes(2);
    expect(enqueueRefund).toHaveBeenCalledWith('t-1', 'e-1');
    expect(enqueueRefund).toHaveBeenCalledWith('t-2', 'e-1');
  });

  it('cancels without enqueuing when there are no crypto tickets', async () => {
    const { service, enqueueRefund, update } = setup(eventRow(), []);

    await service.cancel('e-1', 'org-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: EventStatus.CANCELLED } }),
    );
    expect(enqueueRefund).not.toHaveBeenCalled();
  });

  it('blocks cancelling a non-refundable published event with sold tickets', async () => {
    const { service, enqueueRefund } = setup(
      eventRow({ isRefundable: false }),
      ['t-1'],
    );

    await expect(service.cancel('e-1', 'org-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(enqueueRefund).not.toHaveBeenCalled();
  });
});
