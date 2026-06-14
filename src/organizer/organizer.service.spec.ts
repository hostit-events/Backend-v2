import { EventStatus, TicketStatus } from '@prisma/client';
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
