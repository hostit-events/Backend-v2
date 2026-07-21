import { PayoutStatus } from '@prisma/client';
import { PayoutFinalizerService } from './payout-finalizer.service';

const EVENT = 'evt-1';
const CHAIN = 'BASE-SEPOLIA';

function setup(
  opts: {
    activePayout?: { id: string } | null;
    balances?: bigint[];
  } = {},
) {
  const { activePayout = { id: 'p-1' }, balances = [0n] } = opts;

  const findFirst = jest.fn().mockResolvedValue(activePayout);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const findManyTypes = jest
    .fn()
    .mockResolvedValue(
      balances.map((_, i) => ({ onChainTicketId: BigInt(i + 1) })),
    );

  let call = 0;
  const getTicketBalance = jest.fn(() =>
    Promise.resolve(balances[call++] ?? 0n),
  );
  // No TicketBalanceWithdrawn log → extractWithdrawn returns null; the
  // completion path still runs.
  const getProvider = jest.fn(() => ({
    getTransactionReceipt: jest.fn().mockResolvedValue({ logs: [] }),
  }));

  const prisma = {
    payout: { findFirst, updateMany },
    ticketType: { findMany: findManyTypes },
  };
  const read = { getProvider, getTicketBalance };

  const service = new PayoutFinalizerService(prisma as never, read as never);
  return { service, updateMany, findFirst };
}

describe('PayoutFinalizerService.finalize — auto-complete', () => {
  it('completes the payout once escrow is fully drained', async () => {
    const m = setup({ balances: [0n, 0n] });

    await m.service.finalize({ eventId: EVENT, chain: CHAIN }, '0xhash');

    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PayoutStatus.COMPLETED,
          providerReference: '0xhash',
        }),
      }),
    );
  });

  it('leaves the payout PROCESSING while escrow remains', async () => {
    const m = setup({ balances: [0n, 5n] });

    await m.service.finalize({ eventId: EVENT, chain: CHAIN }, '0xhash');

    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('no-ops when the event has no active payout', async () => {
    const m = setup({ activePayout: null });

    await m.service.finalize({ eventId: EVENT, chain: CHAIN }, '0xhash');

    expect(m.updateMany).not.toHaveBeenCalled();
  });
});
