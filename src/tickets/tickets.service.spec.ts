import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CryptoCheckoutService } from '../payments/crypto-checkout.service';
import { WalletsService } from '../wallets/wallets.service';
import { CheckinQueueService } from '../blockchain/checkin-queue.service';
import { MintQueueService } from '../blockchain/mint-queue.service';
import { TicketsService } from './tickets.service';
import { QueryMyTicketsDto } from './dto/query-my-tickets.dto';
import { VerifyTicketDto } from './dto/verify-ticket.dto';
import { CheckInTicketDto } from './dto/checkin-ticket.dto';

/** A row shaped like TICKET_DETAIL_INCLUDE + the raw buyer columns. */
function sampleTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    reference: 'HOSTIT_TKT_A3F2B9C1',
    status: 'CONFIRMED',
    buyerName: 'Jane Doe',
    buyerEmail: 'jane@example.com',
    buyerPhone: '+2348012345678',
    qrCode: 'https://cdn.hostit.ng/qr/A3F2B9C1.png',
    tokenId: 42,
    deliveryChannel: 'EMAIL',
    checkedInAt: null,
    createdAt: new Date('2026-03-12T10:00:00Z'),
    ticketType: { name: 'VIP', description: 'Front row', price: 50000 },
    event: {
      id: 'event-1',
      name: 'Lagos Tech Summit 2026',
      slug: 'lagos-tech-summit-2026',
      venue: 'Eko Convention Center',
      location: 'Lagos',
      startTime: new Date('2026-05-15T09:00:00Z'),
      endTime: new Date('2026-05-16T18:00:00Z'),
      coverImage: 'https://cdn.hostit.ng/events/cover-123.jpg',
      organizer: { firstName: 'John', lastName: 'Doe' },
    },
    ...overrides,
  };
}

function makeService(
  prismaMock: Partial<PrismaService['ticket']>,
  checkinQueue: { enqueueCheckin: jest.Mock } = { enqueueCheckin: jest.fn() },
) {
  const prisma = {
    ticket: prismaMock,
  } as unknown as PrismaService;
  const config = {
    get: () => undefined,
  } as unknown as ConfigService;
  return new TicketsService(
    prisma,
    {} as unknown as PaymentsService,
    {} as unknown as CryptoCheckoutService,
    {} as unknown as WalletsService,
    config,
    checkinQueue as unknown as CheckinQueueService,
    { enqueueMint: jest.fn() } as unknown as MintQueueService,
  );
}

function query(overrides: Partial<QueryMyTicketsDto> = {}): QueryMyTicketsDto {
  return { page: 1, limit: 10, skip: 0, ...overrides } as QueryMyTicketsDto;
}

describe('TicketsService.findMyTickets', () => {
  it('scopes to the buyer, orders newest first, paginates', async () => {
    const findMany = jest.fn().mockResolvedValue([sampleTicket()]);
    const count = jest.fn().mockResolvedValue(1);
    const svc = makeService({ findMany, count });

    const result = await svc.findMyTickets('buyer-1', query());

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ buyerId: 'buyer-1' });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(10);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });

  it('applies status and eventId filters when provided', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const svc = makeService({ findMany, count });

    await svc.findMyTickets(
      'buyer-1',
      query({
        status: 'USED' as QueryMyTicketsDto['status'],
        eventId: 'event-9',
      }),
    );

    expect(findMany.mock.calls[0][0].where).toEqual({
      buyerId: 'buyer-1',
      status: 'USED',
      eventId: 'event-9',
    });
  });

  it('returns an empty list (not an error) when the buyer has no tickets', async () => {
    const svc = makeService({
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    });

    const result = await svc.findMyTickets('buyer-1', query());
    expect(result.tickets).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it("omits buyer name/email/phone from a buyer's own list", async () => {
    const svc = makeService({
      findMany: jest.fn().mockResolvedValue([sampleTicket()]),
      count: jest.fn().mockResolvedValue(1),
    });

    const [ticket] = (await svc.findMyTickets('buyer-1', query())).tickets;
    expect(ticket).not.toHaveProperty('buyerName');
    expect(ticket).not.toHaveProperty('buyerEmail');
    expect(ticket).not.toHaveProperty('buyerPhone');
    expect(ticket.ticketType.price).toBe(50000);
  });
});

describe('TicketsService.findByReference', () => {
  it('returns the ticket with buyer + organizer name, never email/phone', async () => {
    const svc = makeService({
      findUnique: jest.fn().mockResolvedValue(sampleTicket()),
    });

    const ticket = await svc.findByReference('HOSTIT_TKT_A3F2B9C1');

    expect(ticket).toMatchObject({
      reference: 'HOSTIT_TKT_A3F2B9C1',
      buyerName: 'Jane Doe',
      event: { organizer: { firstName: 'John', lastName: 'Doe' } },
    });
    expect(ticket).not.toHaveProperty('buyerEmail');
    expect(ticket).not.toHaveProperty('buyerPhone');
  });

  it('throws NotFoundException for an unknown reference', async () => {
    const svc = makeService({
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(svc.findByReference('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TicketsService.verifyTicket', () => {
  const EVENT_ID = 'event-1';
  const ORGANIZER_ID = 'organizer-1';
  const HOUR = 60 * 60 * 1000;

  /** A row shaped like verifyTicket's include. Event window straddles now. */
  function verifyRow(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      reference: 'HOSTIT_TKT_A3F2B9C1',
      status: TicketStatus.CONFIRMED,
      buyerName: 'Jane Doe',
      tokenId: 42,
      checkedInAt: null,
      eventId: EVENT_ID,
      ticketType: { name: 'VIP' },
      event: {
        id: EVENT_ID,
        organizerId: ORGANIZER_ID,
        startTime: new Date(now - HOUR),
        endTime: new Date(now + HOUR),
      },
      ...overrides,
    };
  }

  const organizer = { id: ORGANIZER_ID, role: UserRole.ORGANIZER };
  const body: VerifyTicketDto = { eventId: EVENT_ID };

  function svcWith(row: unknown, update = jest.fn()) {
    return makeService({
      findUnique: jest.fn().mockResolvedValue(row),
      update,
    });
  }

  it('404 when the reference is unknown', async () => {
    const svc = svcWith(null);
    await expect(
      svc.verifyTicket('nope', body, organizer),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403 when caller is neither admin nor the event organizer', async () => {
    const svc = svcWith(verifyRow());
    await expect(
      svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, {
        id: 'someone-else',
        role: UserRole.ORGANIZER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an admin who does not own the event', async () => {
    const svc = svcWith(verifyRow());
    const res = await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, {
      id: 'admin-9',
      role: UserRole.ADMIN,
    });
    expect(res.valid).toBe(true);
  });

  it('valid:true for a CONFIRMED ticket inside the event window', async () => {
    const svc = svcWith(verifyRow());
    const res = await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, organizer);
    expect(res).toMatchObject({
      valid: true,
      status: TicketStatus.CONFIRMED,
      ticketType: 'VIP',
      tokenId: 42,
      message: 'Ticket is valid for entry.',
    });
  });

  it('valid:false when the ticket belongs to a different event', async () => {
    const svc = svcWith(verifyRow({ eventId: 'other-event' }));
    const res = await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, organizer);
    expect(res).toMatchObject({
      valid: false,
      message: 'Ticket is not valid for this event.',
    });
  });

  it('valid:false outside the event window', async () => {
    const now = Date.now();
    const svc = svcWith(
      verifyRow({
        event: {
          id: EVENT_ID,
          organizerId: ORGANIZER_ID,
          startTime: new Date(now + HOUR),
          endTime: new Date(now + 2 * HOUR),
        },
      }),
    );
    const res = await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, organizer);
    expect(res).toMatchObject({
      valid: false,
      message: 'Event is not currently active.',
    });
  });

  it.each([
    [TicketStatus.USED, 'Ticket has already been used.'],
    [TicketStatus.PENDING, 'Ticket payment is pending.'],
    [TicketStatus.CANCELLED, 'Ticket has been cancelled.'],
    [TicketStatus.REFUNDED, 'Ticket has been refunded.'],
  ])('valid:false for status %s', async (status, message) => {
    const svc = svcWith(verifyRow({ status }));
    const res = await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, organizer);
    expect(res).toMatchObject({ valid: false, message });
  });

  it('never modifies ticket state', async () => {
    const update = jest.fn();
    const svc = svcWith(verifyRow(), update);
    await svc.verifyTicket('HOSTIT_TKT_A3F2B9C1', body, organizer);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('TicketsService.checkIn', () => {
  const EVENT_ID = 'event-1';
  const ORGANIZER_ID = 'organizer-1';
  const HOUR = 60 * 60 * 1000;
  const organizer = { id: ORGANIZER_ID, role: UserRole.ORGANIZER };
  const body: CheckInTicketDto = { eventId: EVENT_ID };

  /** A row shaped like checkIn's include. Event window straddles now. */
  function checkinRow(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id: 'ticket-1',
      reference: 'HOSTIT_TKT_A3F2B9C1',
      status: TicketStatus.CONFIRMED,
      buyerName: 'Jane Doe',
      eventId: EVENT_ID,
      ticketType: { name: 'VIP' },
      event: {
        id: EVENT_ID,
        organizerId: ORGANIZER_ID,
        startTime: new Date(now - HOUR),
        endTime: new Date(now + HOUR),
      },
      ...overrides,
    };
  }

  function build(row: unknown, opts: { updateCount?: number } = {}) {
    const findUnique = jest.fn().mockResolvedValue(row);
    const updateMany = jest
      .fn()
      .mockResolvedValue({ count: opts.updateCount ?? 1 });
    const enqueueCheckin = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({ findUnique, updateMany }, { enqueueCheckin });
    return { svc, findUnique, updateMany, enqueueCheckin };
  }

  it('flips CONFIRMED → USED, enqueues the on-chain check-in, returns success', async () => {
    const { svc, updateMany, enqueueCheckin } = build(checkinRow());

    const res = await svc.checkIn('HOSTIT_TKT_A3F2B9C1', body, organizer);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ticket-1', status: TicketStatus.CONFIRMED },
        data: expect.objectContaining({ status: TicketStatus.USED }),
      }),
    );
    expect(enqueueCheckin).toHaveBeenCalledWith(
      'ticket-1',
      EVENT_ID,
      expect.objectContaining({ scannedBy: ORGANIZER_ID }),
    );
    expect(res).toMatchObject({
      status: TicketStatus.USED,
      ticketType: 'VIP',
      buyerName: 'Jane Doe',
      message: 'Check-in successful. On-chain recording in progress.',
    });
    expect(res.checkedInAt).toBeInstanceOf(Date);
  });

  it('404 when the reference is unknown', async () => {
    const { svc } = build(null);
    await expect(svc.checkIn('nope', body, organizer)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403 when caller is neither admin nor the event organizer', async () => {
    const { svc, enqueueCheckin } = build(checkinRow());
    await expect(
      svc.checkIn('ref', body, {
        id: 'someone-else',
        role: UserRole.ORGANIZER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(enqueueCheckin).not.toHaveBeenCalled();
  });

  it('400 when the ticket belongs to a different event', async () => {
    const { svc } = build(checkinRow({ eventId: 'other-event' }));
    await expect(svc.checkIn('ref', body, organizer)).rejects.toThrow(
      'Ticket is not valid for this event.',
    );
  });

  it.each([
    [TicketStatus.USED, 'Ticket has already been used.'],
    [TicketStatus.PENDING, 'Ticket payment is pending.'],
    [TicketStatus.CANCELLED, 'Ticket has been cancelled.'],
    [TicketStatus.REFUNDED, 'Ticket has been refunded.'],
  ])('400 for non-CONFIRMED status %s', async (status, message) => {
    const { svc, enqueueCheckin } = build(checkinRow({ status }));
    await expect(svc.checkIn('ref', body, organizer)).rejects.toThrow(message);
    expect(enqueueCheckin).not.toHaveBeenCalled();
  });

  it('400 when outside the check-in window', async () => {
    const now = Date.now();
    const { svc } = build(
      checkinRow({
        event: {
          id: EVENT_ID,
          organizerId: ORGANIZER_ID,
          startTime: new Date(now + HOUR),
          endTime: new Date(now + 2 * HOUR),
        },
      }),
    );
    await expect(svc.checkIn('ref', body, organizer)).rejects.toThrow(
      'Event is not within the check-in window.',
    );
  });

  it('400 (already used) when the atomic flip updates 0 rows (race/replay)', async () => {
    const { svc, enqueueCheckin } = build(checkinRow(), { updateCount: 0 });
    await expect(svc.checkIn('ref', body, organizer)).rejects.toThrow(
      'Ticket has already been used.',
    );
    expect(enqueueCheckin).not.toHaveBeenCalled();
  });

  it('allows an admin who does not own the event', async () => {
    const { svc, enqueueCheckin } = build(checkinRow());
    const res = await svc.checkIn('ref', body, {
      id: 'admin-9',
      role: UserRole.ADMIN,
    });
    expect(res.status).toBe(TicketStatus.USED);
    expect(enqueueCheckin).toHaveBeenCalled();
  });
});
