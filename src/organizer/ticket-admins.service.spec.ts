import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  BlockchainTxType,
  TicketAdminStatus,
  UserRole,
  WalletCreationStatus,
} from '@prisma/client';
import { TicketAdminsService } from './ticket-admins.service';

const ORG = 'org-1';
const EVENT = 'evt-1';
const CHAIN = 'BASE-SEPOLIA';

type WalletRow = { address?: string; circleWalletId?: string } | null;

function setup(opts: {
  ownerId?: string;
  onChainTicketIds?: (bigint | null)[];
  organizerWallet?: WalletRow;
  users?: Record<string, { role: UserRole } | undefined>;
  targetWallets?: Record<string, WalletRow>;
  activeAdmins?: { userId: string; address: string }[];
}) {
  const {
    ownerId = ORG,
    onChainTicketIds = [1n, 2n],
    organizerWallet = { circleWalletId: 'org-wallet' },
    users = {},
    targetWallets = {},
    activeAdmins = [],
  } = opts;

  const upsert = jest.fn(async (a: any) => a);
  const updateMany = jest.fn(async () => ({ count: activeAdmins.length }));
  const findMany = jest.fn(async () =>
    activeAdmins.map((a) => ({
      userId: a.userId,
      address: a.address,
      status: TicketAdminStatus.ACTIVE,
      createdAt: new Date('2026-07-19T00:00:00Z'),
      user: {
        id: a.userId,
        firstName: 'Del',
        lastName: a.userId,
        email: `${a.userId}@x.com`,
      },
    })),
  );

  const prisma = {
    event: {
      findUnique: jest.fn(async () => ({
        id: EVENT,
        organizerId: ownerId,
        chain: CHAIN,
        ticketTypes: onChainTicketIds.map((onChainTicketId) => ({
          onChainTicketId,
        })),
      })),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = users[where.id];
        return u ? { id: where.id, role: u.role } : null;
      }),
    },
    userWallet: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.userId === ORG) return organizerWallet;
        return targetWallets[where.userId] ?? null;
      }),
    },
    eventTicketAdmin: { upsert, findMany, updateMany },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const circle = { executeContract: jest.fn(async () => ({})) };
  const wallets = { ensureWalletsForActiveChains: jest.fn(async () => undefined) };

  const svc = new TicketAdminsService(
    prisma as any,
    circle as any,
    wallets as any,
  );
  return { svc, prisma, circle, wallets, upsert, updateMany };
}

describe('TicketAdminsService (#101)', () => {
  it('grants: one on-chain call per ticket type, records delegates ACTIVE', async () => {
    const { svc, circle, upsert } = setup({
      users: { 'u-1': { role: UserRole.BUYER } },
      targetWallets: { 'u-1': { address: '0xabc' } },
      activeAdmins: [{ userId: 'u-1', address: '0xabc' }],
    });

    await svc.addAdmins(ORG, EVENT, ['u-1']);

    // 2 ticket types → 2 addTicketAdmins calls, each with the address list
    expect(circle.executeContract).toHaveBeenCalledTimes(2);
    const call = circle.executeContract.mock.calls[0][0];
    expect(call.method).toBe('addTicketAdmins');
    expect(call.args[1]).toEqual(['0xabc']);
    expect(call.txType).toBe(BlockchainTxType.SET_ADMINS);
    expect(call.walletId).toBe('org-wallet');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-owner with 403', async () => {
    const { svc, circle } = setup({ ownerId: 'someone-else' });
    await expect(svc.addAdmins(ORG, EVENT, ['u-1'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(circle.executeContract).not.toHaveBeenCalled();
  });

  it('kicks provisioning and rejects when target has no wallet', async () => {
    const { svc, circle, wallets } = setup({
      users: { 'u-1': { role: UserRole.BUYER } },
      targetWallets: { 'u-1': null },
    });
    await expect(svc.addAdmins(ORG, EVENT, ['u-1'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(wallets.ensureWalletsForActiveChains).toHaveBeenCalledWith('u-1');
    expect(circle.executeContract).not.toHaveBeenCalled();
  });

  it('rejects platform admins as targets', async () => {
    const { svc } = setup({
      users: { 'u-1': { role: UserRole.ADMIN } },
      targetWallets: { 'u-1': { address: '0xabc' } },
    });
    await expect(svc.addAdmins(ORG, EVENT, ['u-1'])).rejects.toThrow(
      /platform admin/,
    );
  });

  it('rejects when the event has no on-chain ticket types yet', async () => {
    const { svc } = setup({
      onChainTicketIds: [null],
      users: { 'u-1': { role: UserRole.BUYER } },
      targetWallets: { 'u-1': { address: '0xabc' } },
    });
    await expect(svc.addAdmins(ORG, EVENT, ['u-1'])).rejects.toThrow(
      /no on-chain ticket types/,
    );
  });

  it('revokes: on-chain removeTicketAdmins per ticket type + marks REVOKED', async () => {
    const { svc, circle, updateMany } = setup({
      activeAdmins: [{ userId: 'u-1', address: '0xabc' }],
    });
    await svc.removeAdmins(ORG, EVENT, ['u-1']);
    expect(circle.executeContract).toHaveBeenCalledTimes(2);
    expect(circle.executeContract.mock.calls[0][0].method).toBe(
      'removeTicketAdmins',
    );
    expect(updateMany).toHaveBeenCalled();
  });

  it('revoke with no matching active admins → 400', async () => {
    const { svc, circle } = setup({ activeAdmins: [] });
    await expect(svc.removeAdmins(ORG, EVENT, ['u-1'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(circle.executeContract).not.toHaveBeenCalled();
  });

  it('rejects the organizer delegating to themselves', async () => {
    const { svc } = setup({});
    await expect(svc.addAdmins(ORG, EVENT, [ORG])).rejects.toThrow(
      /already the ticket admin/,
    );
  });
});
