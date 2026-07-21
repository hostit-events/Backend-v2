import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  EventStatus,
  PaymentProvider,
  PayoutStatus,
  Prisma,
} from '@prisma/client';
import { PayoutsService } from './payouts.service';

const ORG = 'org-1';
const EVENT = 'evt-1';
const CHAIN = 'BASE-SEPOLIA';
const PAST = new Date('2020-01-01T00:00:00Z');
const REFUND_PERIOD = 259_200n; // 3 days in seconds

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    name: 'Lagos Tech Summit',
    organizerId: ORG,
    status: EventStatus.COMPLETED,
    endTime: PAST,
    chain: CHAIN,
    ticketTypes: [
      { id: 'tt-1', onChainTicketId: 7n },
      { id: 'tt-2', onChainTicketId: 8n },
    ],
    ...overrides,
  };
}

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    eventId: EVENT,
    amount: new Prisma.Decimal('1'),
    currency: 'USDC',
    provider: PaymentProvider.CRYPTO,
    status: PayoutStatus.PROCESSING,
    providerReference: null,
    scheduledDate: PAST,
    processedAt: null,
    createdAt: PAST,
    event: { name: 'Lagos Tech Summit' },
    ...overrides,
  };
}

function setup(
  opts: {
    event?: Record<string, unknown> | null;
    refundPeriod?: bigint;
    duplicate?: unknown;
    balances?: Record<string, bigint>;
  } = {},
) {
  const {
    event = eventRow(),
    refundPeriod = REFUND_PERIOD,
    duplicate = null,
    balances = { '7': 1_000_000n, '8': 0n },
  } = opts;

  const findEvent = jest.fn().mockResolvedValue(event);
  const findFirst = jest.fn().mockResolvedValue(duplicate);
  const create = jest
    .fn()
    .mockResolvedValue(payoutRow({ status: PayoutStatus.PENDING }));
  const update = jest.fn().mockResolvedValue(payoutRow());
  const getRefundPeriod = jest.fn().mockResolvedValue(refundPeriod);
  const getTicketBalance = jest.fn((_c: string, id: bigint) =>
    Promise.resolve(balances[id.toString()] ?? 0n),
  );
  const enqueuePayout = jest.fn().mockResolvedValue(undefined);

  const prisma = {
    event: { findUnique: findEvent },
    payout: { findFirst, create, update },
  };
  const read = { getRefundPeriod, getTicketBalance };

  const service = new PayoutsService(
    prisma as never,
    read as never,
    { enqueuePayout } as never,
  );
  return { service, enqueuePayout, create, update, getTicketBalance };
}

describe('PayoutsService.requestPayout', () => {
  it('withdraws escrow: enqueues per ticket type with a balance, returns PROCESSING', async () => {
    const m = setup();

    const res = await m.service.requestPayout(ORG, EVENT);

    // Only tt-1 has a balance; tt-2 (zero) is skipped.
    expect(m.enqueuePayout).toHaveBeenCalledTimes(1);
    expect(m.enqueuePayout).toHaveBeenCalledWith('tt-1', EVENT);
    // Amount is escrow base units / 1e6.
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currency: 'USDC',
          provider: PaymentProvider.CRYPTO,
        }),
      }),
    );
    expect(res.status).toBe(PayoutStatus.PROCESSING);
    expect(res.amount).toBe('1');
  });

  it('rejects a non-owner', async () => {
    const m = setup({ event: eventRow({ organizerId: 'someone-else' }) });
    await expect(m.service.requestPayout(ORG, EVENT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(m.enqueuePayout).not.toHaveBeenCalled();
  });

  it('rejects a draft event', async () => {
    const m = setup({ event: eventRow({ status: EventStatus.DRAFT }) });
    await expect(m.service.requestPayout(ORG, EVENT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects before the refund period elapses', async () => {
    const m = setup({ event: eventRow({ endTime: new Date() }) });
    await expect(m.service.requestPayout(ORG, EVENT)).rejects.toThrow(
      /Refund period/,
    );
    expect(m.enqueuePayout).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending/processing payout', async () => {
    const m = setup({ duplicate: { id: 'existing' } });
    await expect(m.service.requestPayout(ORG, EVENT)).rejects.toThrow(
      /already pending/,
    );
    expect(m.enqueuePayout).not.toHaveBeenCalled();
  });

  it('rejects when there is no withdrawable escrow', async () => {
    const m = setup({ balances: { '7': 0n, '8': 0n } });
    await expect(m.service.requestPayout(ORG, EVENT)).rejects.toThrow(
      /No withdrawable/,
    );
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('PayoutsService.getPayoutHistory', () => {
  function historyService(rows: unknown[], total: number) {
    const $transaction = jest
      .fn()
      .mockResolvedValue([
        rows,
        total,
        { _sum: { amount: new Prisma.Decimal('8.5') } },
        { _sum: { amount: new Prisma.Decimal('1.25') } },
        total,
      ]);
    const prisma = {
      payout: {
        findMany: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
      },
      $transaction,
    };
    return new PayoutsService(prisma as never, {} as never, {} as never);
  }

  it('returns mapped payouts, summary, and pagination', async () => {
    const service = historyService(
      [payoutRow({ status: PayoutStatus.COMPLETED })],
      1,
    );

    const res = await service.getPayoutHistory(ORG, {
      page: 1,
      limit: 10,
      skip: 0,
    } as never);

    expect(res.payouts).toHaveLength(1);
    expect(res.payouts[0].eventName).toBe('Lagos Tech Summit');
    expect(res.summary).toEqual({
      totalPaid: '8.5',
      pendingAmount: '1.25',
      totalPayouts: 1,
    });
    expect(res.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });
});
