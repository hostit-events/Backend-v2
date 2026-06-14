import { EventStatus, TicketStatus, UserRole } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { OrganizerService } from './organizer.service';
import { QueryOrganizerEventsDto } from './dto/query-organizer-events.dto';

/**
 * getMyEvents leans on prisma aggregations. We stub each call the method
 * makes, in order, so we can assert the derived stats without a DB.
 */
function setup(opts: {
  totalEvents?: number;
  publishedEvents?: number;
  soldGroupsAll?: { ticketTypeId: string; _count: { _all: number } }[];
  typePrices?: { id: string; price: number }[];
  events?: unknown[];
  total?: number;
  ticketGroups?: {
    ticketTypeId: string;
    status: TicketStatus;
    _count: { _all: number };
  }[];
}) {
  const eventCount = jest
    .fn()
    .mockResolvedValueOnce(opts.totalEvents ?? 0) // totalEvents
    .mockResolvedValueOnce(opts.publishedEvents ?? 0) // publishedEvents
    .mockResolvedValueOnce(opts.total ?? 0); // pagination total
  const eventFindMany = jest.fn().mockResolvedValue(opts.events ?? []);

  const ticketGroupBy = jest
    .fn()
    .mockResolvedValueOnce(opts.soldGroupsAll ?? []) // summary groupBy
    .mockResolvedValueOnce(opts.ticketGroups ?? []); // page groupBy
  const ticketTypeFindMany = jest.fn().mockResolvedValue(opts.typePrices ?? []);

  const prisma = {
    event: { count: eventCount, findMany: eventFindMany },
    ticket: { groupBy: ticketGroupBy },
    ticketType: { findMany: ticketTypeFindMany },
  } as unknown as PrismaService;

  const svc = new OrganizerService(
    prisma,
    { get: () => undefined } as unknown as ConfigService,
    {} as unknown as PaystackService,
    {} as unknown as MonnifyProvider,
  );
  return { svc, eventFindMany };
}

function query(
  overrides: Partial<QueryOrganizerEventsDto> = {},
): QueryOrganizerEventsDto {
  return {
    page: 1,
    limit: 10,
    skip: 0,
    ...overrides,
  } as QueryOrganizerEventsDto;
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    name: 'Lagos Tech Summit',
    slug: 'lagos-tech-summit',
    coverImage: null,
    startTime: new Date('2026-05-15T09:00:00Z'),
    endTime: new Date('2026-05-16T18:00:00Z'),
    status: EventStatus.PUBLISHED,
    category: 'CONFERENCE',
    createdAt: new Date('2026-03-12T10:00:00Z'),
    ticketTypes: [
      { id: 'tt-gen', name: 'General', price: 15000, quantity: 500 },
      { id: 'tt-vip', name: 'VIP', price: 50000, quantity: 100 },
    ],
    ...overrides,
  };
}

describe('OrganizerService.getMyEvents', () => {
  it('derives per-type, per-event, and summary stats', async () => {
    const { svc } = setup({
      totalEvents: 1,
      publishedEvents: 1,
      total: 1,
      // summary: 120 General + 45 VIP sold across all events
      soldGroupsAll: [
        { ticketTypeId: 'tt-gen', _count: { _all: 120 } },
        { ticketTypeId: 'tt-vip', _count: { _all: 45 } },
      ],
      typePrices: [
        { id: 'tt-gen', price: 15000 },
        { id: 'tt-vip', price: 50000 },
      ],
      events: [eventRow()],
      // page: General 120 sold (10 checked in), VIP 45 sold (0 checked in)
      ticketGroups: [
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.CONFIRMED,
          _count: { _all: 110 },
        },
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.USED,
          _count: { _all: 10 },
        },
        {
          ticketTypeId: 'tt-vip',
          status: TicketStatus.CONFIRMED,
          _count: { _all: 45 },
        },
      ],
    });

    const res = await svc.getMyEvents('org-1', query());

    expect(res.summary).toEqual({
      totalEvents: 1,
      publishedEvents: 1,
      totalTicketsSold: 165,
      totalRevenue: 120 * 15000 + 45 * 50000, // 4,050,000
    });

    const [event] = res.events;
    expect(event.stats).toEqual({
      totalTickets: 600,
      ticketsSold: 165,
      ticketsAvailable: 435,
      totalRevenue: 120 * 15000 + 45 * 50000,
      checkedIn: 10,
      ticketTypes: [
        { name: 'General', sold: 120, total: 500, revenue: 1_800_000 },
        { name: 'VIP', sold: 45, total: 100, revenue: 2_250_000 },
      ],
    });
    // ticketTypes relation is replaced by stats, not leaked on the event.
    expect(event).not.toHaveProperty('ticketTypes');
    expect(res.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });

  it('excludes PENDING/CANCELLED/REFUNDED from sold and checked-in', async () => {
    const { svc } = setup({
      totalEvents: 1,
      publishedEvents: 1,
      total: 1,
      soldGroupsAll: [{ ticketTypeId: 'tt-gen', _count: { _all: 2 } }],
      typePrices: [{ id: 'tt-gen', price: 15000 }],
      events: [
        eventRow({
          ticketTypes: [
            { id: 'tt-gen', name: 'General', price: 15000, quantity: 500 },
          ],
        }),
      ],
      ticketGroups: [
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.CONFIRMED,
          _count: { _all: 2 },
        },
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.PENDING,
          _count: { _all: 7 },
        },
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.CANCELLED,
          _count: { _all: 3 },
        },
      ],
    });

    const res = await svc.getMyEvents('org-1', query());
    expect(res.events[0].stats.ticketsSold).toBe(2);
    expect(res.events[0].stats.checkedIn).toBe(0);
  });

  it('passes the status filter and pagination into the events query', async () => {
    const { svc, eventFindMany } = setup({
      events: [],
      total: 0,
    });

    await svc.getMyEvents(
      'org-1',
      query({ page: 2, limit: 5, skip: 5, status: EventStatus.DRAFT }),
    );

    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizerId: 'org-1', status: EventStatus.DRAFT },
        orderBy: { createdAt: 'desc' },
        skip: 5,
        take: 5,
      }),
    );
  });

  it('returns zeroed summary and empty list for an organizer with no events', async () => {
    const { svc } = setup({});
    const res = await svc.getMyEvents('org-1', query());
    expect(res.summary).toEqual({
      totalEvents: 0,
      publishedEvents: 0,
      totalRevenue: 0,
      totalTicketsSold: 0,
    });
    expect(res.events).toEqual([]);
  });
});

describe('OrganizerService.getEventAnalytics', () => {
  const ORG = 'org-1';
  const DAY = 24 * 60 * 60 * 1000;

  function analyticsSvc(opts: {
    event?: unknown;
    txns?: unknown[];
    ticketGroups?: {
      ticketTypeId: string;
      status: TicketStatus;
      _count: { _all: number };
    }[];
  }) {
    const findUnique = jest
      .fn()
      .mockResolvedValue(
        opts.event === undefined ? eventForAnalytics() : opts.event,
      );
    const txnFindMany = jest.fn().mockResolvedValue(opts.txns ?? []);
    const ticketGroupBy = jest.fn().mockResolvedValue(opts.ticketGroups ?? []);

    const prisma = {
      event: { findUnique },
      transaction: { findMany: txnFindMany },
      ticket: { groupBy: ticketGroupBy },
    } as unknown as PrismaService;

    const svc = new OrganizerService(
      prisma,
      { get: () => undefined } as unknown as ConfigService,
      {} as unknown as PaystackService,
      {} as unknown as MonnifyProvider,
    );
    return svc;
  }

  function eventForAnalytics(overrides: Record<string, unknown> = {}) {
    return {
      id: 'event-1',
      name: 'Lagos Tech Summit',
      status: EventStatus.PUBLISHED,
      startTime: new Date('2026-05-15T09:00:00Z'),
      organizerId: ORG,
      ticketTypes: [
        { id: 'tt-gen', name: 'General', price: 15000, quantity: 500 },
        { id: 'tt-vip', name: 'VIP', price: 50000, quantity: 100 },
      ],
      ...overrides,
    };
  }

  const admin = { id: 'admin-9', role: UserRole.ADMIN };
  const owner = { id: ORG, role: UserRole.ORGANIZER };

  it('404 when the event does not exist', async () => {
    const svc = analyticsSvc({ event: null });
    await expect(svc.getEventAnalytics('nope', owner)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403 when the caller is neither owner nor admin', async () => {
    const svc = analyticsSvc({});
    await expect(
      svc.getEventAnalytics('event-1', {
        id: 'intruder',
        role: UserRole.ORGANIZER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an admin who does not own the event', async () => {
    const svc = analyticsSvc({});
    const res = await svc.getEventAnalytics('event-1', admin);
    expect(res.event.id).toBe('event-1');
  });

  it('computes overview, breakdowns, and provider/channel splits', async () => {
    const svc = analyticsSvc({
      txns: [
        {
          amount: 1_800_000,
          provider: 'PAYSTACK',
          quantity: 120,
          createdAt: new Date('2026-04-01T10:00:00Z'),
          metadata: { channel: 'card' },
        },
        {
          amount: 2_250_000,
          provider: 'MONNIFY',
          quantity: 45,
          createdAt: new Date('2026-04-01T12:00:00Z'),
          metadata: { channel: 'bank_transfer' },
        },
      ],
      ticketGroups: [
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.CONFIRMED,
          _count: { _all: 110 },
        },
        {
          ticketTypeId: 'tt-gen',
          status: TicketStatus.USED,
          _count: { _all: 10 },
        },
        {
          ticketTypeId: 'tt-vip',
          status: TicketStatus.CONFIRMED,
          _count: { _all: 45 },
        },
      ],
    });

    const res = await svc.getEventAnalytics('event-1', owner);

    expect(res.overview).toEqual({
      totalRevenue: 4_050_000,
      totalTicketsSold: 165,
      totalTicketsAvailable: 435,
      totalCheckedIn: 10,
      checkInRate: 6, // round(10/165*100)
      averageTicketPrice: Math.round(4_050_000 / 165),
    });
    expect(res.ticketTypeBreakdown).toEqual([
      {
        name: 'General',
        price: 15000,
        sold: 120,
        total: 500,
        revenue: 1_800_000,
        percentSold: 24,
      },
      {
        name: 'VIP',
        price: 50000,
        sold: 45,
        total: 100,
        revenue: 2_250_000,
        percentSold: 45,
      },
    ]);
    expect(res.revenueByProvider).toEqual([
      { provider: 'PAYSTACK', amount: 1_800_000, count: 120 },
      { provider: 'MONNIFY', amount: 2_250_000, count: 45 },
    ]);
    expect(res.revenueByChannel).toEqual([
      { channel: 'card', amount: 1_800_000, count: 120 },
      { channel: 'bank_transfer', amount: 2_250_000, count: 45 },
    ]);
  });

  it('gap-fills daily sales between sale days (no date holes)', async () => {
    const start = new Date('2026-04-01T10:00:00Z');
    const twoDaysLater = new Date(start.getTime() + 2 * DAY);
    const svc = analyticsSvc({
      txns: [
        {
          amount: 100,
          provider: 'PAYSTACK',
          quantity: 1,
          createdAt: start,
          metadata: {},
        },
        {
          amount: 300,
          provider: 'PAYSTACK',
          quantity: 3,
          createdAt: twoDaysLater,
          metadata: {},
        },
      ],
    });

    const res = await svc.getEventAnalytics('event-1', owner);

    // First three entries are contiguous days with the middle zero-filled.
    expect(res.dailySales.slice(0, 3)).toEqual([
      { date: '2026-04-01', ticketsSold: 1, revenue: 100 },
      { date: '2026-04-02', ticketsSold: 0, revenue: 0 },
      { date: '2026-04-03', ticketsSold: 3, revenue: 300 },
    ]);
    // missing channel buckets under 'unknown'
    expect(res.revenueByChannel).toEqual([
      { channel: 'unknown', amount: 400, count: 4 },
    ]);
  });

  it('zeroes rate/average when nothing has sold', async () => {
    const svc = analyticsSvc({ txns: [], ticketGroups: [] });
    const res = await svc.getEventAnalytics('event-1', owner);
    expect(res.overview.checkInRate).toBe(0);
    expect(res.overview.averageTicketPrice).toBe(0);
    expect(res.dailySales).toEqual([]);
  });
});
