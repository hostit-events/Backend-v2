import { BlockchainTxType, WalletCreationStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { MintTicketProcessor } from './mint-ticket.processor';
import { FEE_TYPE_USDC } from './onchain-fees';
import { MINT_TICKET_JOB, MintTicketJobData } from './mint-queue.service';

// getChain is env-driven; stub the USDC + Diamond addresses.
jest.mock('./chains.config', () => ({
  getChain: () => ({
    usdcAddress: '0xUSDC',
    diamondAddress: '0xDIAMOND',
  }),
}));

function ticketRow(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    reference: 'HOSTIT_TXN_1',
    tokenId: null,
    status: 'PENDING',
    buyerEmail: 'b@x.com',
    ticketType: { id: 'tt-1', onChainTicketId: 7n, price: 5000 },
    transaction: { provider },
    event: { id: 'e-1', name: 'E', chain: 'BASE-SEPOLIA', slug: 's' },
    buyer: {
      id: 'b-1',
      wallets: [
        {
          id: 'w-1',
          chain: 'BASE-SEPOLIA',
          address: '0xBUYER',
          circleWalletId: 'cw-buyer',
          creationStatus: WalletCreationStatus.CREATED,
        },
      ],
    },
    ...overrides,
  };
}

function setup(provider: string) {
  const findUnique = jest.fn().mockResolvedValue(ticketRow(provider));
  const update = jest.fn().mockResolvedValue({});
  const approveErc20 = jest
    .fn()
    .mockResolvedValue({ circleTransactionId: 'approve-1' });
  const pollUntilTerminal = jest
    .fn()
    .mockResolvedValue({ state: 'CONFIRMED', txHash: '0xhash' });
  const executeContract = jest
    .fn()
    .mockResolvedValue({ circleTransactionId: 'mint-1' });
  const getAllFees = jest.fn().mockResolvedValue({
    ticketFee: 3033980n,
    hostItFee: 91019n,
    totalFee: 3124999n,
  });
  const finalize = jest.fn().mockResolvedValue(true);
  // Webhook authoritative → worker submits and returns (no inline finalize).
  const get = jest.fn().mockReturnValue(true);

  const proc = new MintTicketProcessor(
    { ticket: { findUnique }, blockchainTransaction: { update } } as never,
    { approveErc20, pollUntilTerminal, executeContract } as never,
    { finalize } as never,
    { get } as never,
    { getAllFees } as never,
  );
  return { proc, approveErc20, pollUntilTerminal, executeContract, getAllFees };
}

function job(): Job<MintTicketJobData> {
  return {
    name: MINT_TICKET_JOB,
    data: { ticketId: 't-1', eventId: 'e-1', blockchainTxId: 'bt-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as Job<MintTicketJobData>;
}

describe('MintTicketProcessor', () => {
  it('crypto ticket: approves USDC then mintTicket signed by the buyer wallet', async () => {
    const m = setup('CRYPTO');

    await m.proc.process(job());

    // Authoritative on-chain fee read for the crypto settlement feeType.
    expect(m.getAllFees).toHaveBeenCalledWith(
      'BASE-SEPOLIA',
      7n,
      FEE_TYPE_USDC,
    );
    // Approve the Diamond to pull exactly totalFee from the buyer wallet.
    expect(m.approveErc20).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'cw-buyer',
        tokenAddress: '0xUSDC',
        spender: '0xDIAMOND',
        amount: '3124999',
      }),
    );
    // mintTicket signed by the buyer wallet, buyer as NFT recipient.
    expect(m.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'mintTicket',
        args: [7n, FEE_TYPE_USDC, '0xBUYER'],
        walletId: 'cw-buyer',
        txType: BlockchainTxType.MINT,
        existingBlockchainTransactionId: 'bt-1',
      }),
    );
  });

  it('fiat ticket: free mintFiatTicket via treasury, no approve', async () => {
    const m = setup('PAYSTACK');

    await m.proc.process(job());

    expect(m.approveErc20).not.toHaveBeenCalled();
    expect(m.getAllFees).not.toHaveBeenCalled();
    expect(m.executeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'mintFiatTicket',
        walletId: undefined, // defaults to treasury
      }),
    );
  });
});
