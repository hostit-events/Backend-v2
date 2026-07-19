import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BlockchainTxType, EventStatus } from '@prisma/client';
import { TicketFeesService } from './ticket-fees.service';
import { FEE_TYPE_USDC } from '../blockchain/onchain-fees';

const ORG = 'org-1';
const EVENT = 'evt-1';
const TT = 'tt-1';
const CHAIN = 'BASE-SEPOLIA';
// startTime far in the future so the "event started" guard passes.
const FUTURE = new Date('2099-01-01T00:00:00Z');

function setup(opts: {
  ownerId?: string;
  isFree?: boolean;
  status?: EventStatus;
  startTime?: Date;
  onChainTicketId?: bigint | null;
  organizerWalletId?: string | null;
}) {
  const {
    ownerId = ORG,
    isFree = false,
    status = EventStatus.PUBLISHED,
    startTime = FUTURE,
    onChainTicketId = 7n,
    organizerWalletId = 'org-wallet',
  } = opts;

  const ticketTypeUpdate = jest.fn(() => ({
    id: TT,
    name: 'VIP',
    price: '2000',
  }));

  const prisma = {
    event: {
      findUnique: jest.fn(() => ({
        organizerId: ownerId,
        chain: CHAIN,
        isFree,
        status,
        startTime,
      })),
    },
    ticketType: {
      findFirst: jest.fn(() => ({ id: TT, name: 'VIP', onChainTicketId })),
      update: ticketTypeUpdate,
    },
    userWallet: {
      findFirst: jest.fn(() =>
        organizerWalletId ? { circleWalletId: organizerWalletId } : null,
      ),
    },
  };
  const circle = { executeContract: jest.fn((_p: any) => ({})) };
  const config = { getOrThrow: jest.fn(() => 1600) };

  const svc = new TicketFeesService(
    prisma as any,
    circle as any,
    config as any,
  );
  return { svc, prisma, circle, ticketTypeUpdate };
}

describe('TicketFeesService (#102)', () => {
  it('submits organizer-signed updateTicketFees and updates the DB price', async () => {
    const { svc, circle, ticketTypeUpdate } = setup({});
    await svc.updateFee(ORG, EVENT, TT, 2000);

    expect(circle.executeContract).toHaveBeenCalledTimes(1);
    const call = circle.executeContract.mock.calls[0][0];
    expect(call.method).toBe('updateTicketFees');
    expect(call.args[0]).toBe(7n); // onChainTicketId
    expect(call.args[1]).toEqual([FEE_TYPE_USDC]);
    expect(typeof call.args[2][0]).toBe('bigint'); // fee in USDC base units
    expect(call.txType).toBe(BlockchainTxType.SET_FEES);
    expect(call.walletId).toBe('org-wallet');
    expect(ticketTypeUpdate).toHaveBeenCalled();
  });

  it('rejects a non-owner with 403', async () => {
    const { svc, circle } = setup({ ownerId: 'other' });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(circle.executeContract).not.toHaveBeenCalled();
  });

  it('rejects free events', async () => {
    const { svc } = setup({ isFree: true });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toThrow(/Free/);
  });

  it('rejects non-published events', async () => {
    const { svc } = setup({ status: EventStatus.DRAFT });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toThrow(
      /published/,
    );
  });

  it('rejects once the event has started', async () => {
    const { svc } = setup({ startTime: new Date('2000-01-01T00:00:00Z') });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toThrow(
      /after the event has started/,
    );
  });

  it('rejects a ticket type not yet on-chain', async () => {
    const { svc, circle } = setup({ onChainTicketId: null });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toThrow(
      /not on-chain yet/,
    );
    expect(circle.executeContract).not.toHaveBeenCalled();
  });

  it('rejects when organizer has no ready signing wallet', async () => {
    const { svc } = setup({ organizerWalletId: null });
    await expect(svc.updateFee(ORG, EVENT, TT, 2000)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
