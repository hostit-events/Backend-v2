import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OnchainReadsService } from './onchain-reads.service';

const ORG = 'org-1';
const EVENT = 'evt-1';
const CHAIN = 'BASE-SEPOLIA';

function setup(opts: {
  ownerId?: string;
  ticketTypes?: { id: string; name: string; onChainTicketId: bigint | null }[];
  read?: Partial<{
    getTicketBalance: jest.Mock;
    getCheckedIn: jest.Mock;
    getCheckedInForDay: jest.Mock;
  }>;
}) {
  const {
    ownerId = ORG,
    ticketTypes = [
      { id: 'tt-1', name: 'GA', onChainTicketId: 1n },
      { id: 'tt-2', name: 'VIP', onChainTicketId: 2n },
    ],
    read = {},
  } = opts;

  const prisma = {
    event: {
      findUnique: jest.fn(async () => ({
        organizerId: ownerId,
        chain: CHAIN,
        ticketTypes,
      })),
    },
  };
  const readSvc = {
    getTicketBalance: read.getTicketBalance ?? jest.fn(async () => 1500000n),
    getCheckedIn:
      read.getCheckedIn ?? jest.fn(async () => ['0xa', '0xb', '0xc']),
    getCheckedInForDay: read.getCheckedInForDay ?? jest.fn(async () => ['0xa']),
  };
  const svc = new OnchainReadsService(prisma as any, readSvc as any);
  return { svc, prisma, readSvc };
}

describe('OnchainReadsService (#103)', () => {
  it('returns per-ticket USDC balance formatted 6-dp', async () => {
    const { svc } = setup({});
    const res = await svc.getBalances(ORG, EVENT);
    expect(res.chain).toBe(CHAIN);
    expect(res.tickets).toHaveLength(2);
    expect(res.tickets[0]).toMatchObject({
      ticketTypeId: 'tt-1',
      balanceUsdc: '1.500000',
      balanceRaw: '1500000',
    });
  });

  it('sums check-in totals across ticket types', async () => {
    const { svc } = setup({
      read: {
        getCheckedIn: jest
          .fn()
          .mockResolvedValueOnce(['0xa', '0xb'])
          .mockResolvedValueOnce(['0xc']),
      },
    });
    const res = await svc.getCheckins(ORG, EVENT);
    expect(res.total).toBe(3);
    expect(res.tickets[0].checkedIn).toBe(2);
    expect(res.tickets[1].checkedIn).toBe(1);
  });

  it('is resilient: a failing RPC read becomes an error entry, not a 500', async () => {
    const { svc } = setup({
      read: {
        getTicketBalance: jest
          .fn()
          .mockResolvedValueOnce(2000000n)
          .mockRejectedValueOnce(new Error('rpc down')),
      },
    });
    const res = await svc.getBalances(ORG, EVENT);
    expect(res.tickets[0]).toMatchObject({ balanceUsdc: '2.000000' });
    expect(res.tickets[1]).toMatchObject({ error: 'unavailable' });
  });

  it('skips ticket types not yet on-chain', async () => {
    const { svc, readSvc } = setup({
      ticketTypes: [
        { id: 'tt-1', name: 'GA', onChainTicketId: 1n },
        { id: 'tt-2', name: 'VIP', onChainTicketId: null },
      ],
    });
    const res = await svc.getCheckins(ORG, EVENT);
    expect(res.tickets).toHaveLength(1);
    expect(readSvc.getCheckedIn).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-owner with 403', async () => {
    const { svc } = setup({ ownerId: 'other' });
    await expect(svc.getBalances(ORG, EVENT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('validates the day param', async () => {
    const { svc } = setup({});
    await expect(svc.getCheckinsForDay(ORG, EVENT, -1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.getCheckinsForDay(ORG, EVENT, 300)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns per-day check-in counts', async () => {
    const { svc } = setup({
      read: {
        getCheckedInForDay: jest
          .fn()
          .mockResolvedValueOnce(['0xa', '0xb'])
          .mockResolvedValueOnce([]),
      },
    });
    const res = await svc.getCheckinsForDay(ORG, EVENT, 0);
    expect(res.day).toBe(0);
    expect(res.total).toBe(2);
  });
});
