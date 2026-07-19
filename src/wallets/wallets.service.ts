import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { UserRole, WalletCreationStatus, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  getDefaultChain,
  listActiveChains,
} from '../blockchain/chains.config';
import {
  USER_WALLET_JOB,
  USER_WALLET_QUEUE,
  type UserWalletJobData,
} from './wallets.constants';

export interface EnqueueWalletOptions {
  chain?: string;
  walletType?: WalletType;
  isPrimary?: boolean;
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(USER_WALLET_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Enqueue a Circle wallet for this user on the given chain. Creates
   * the UserWallet row in PENDING state so downstream reads reflect
   * the in-flight provisioning immediately.
   *
   * Admin filtering is the caller's responsibility (see
   * AuthService.register). The processor is defensive regardless.
   */
  async enqueueWalletCreation(
    userId: string,
    options: EnqueueWalletOptions = {},
  ): Promise<void> {
    const chain =
      options.chain ?? this.config.getOrThrow<string>('circle.defaultChain');
    const walletType = options.walletType ?? WalletType.DEVELOPER_CONTROLLED;
    const idempotencyKey = randomUUID();

    // Upsert the wallet row. On retry this flips it back to PENDING
    // and clears the prior error; on first call it creates fresh.
    // The unique (userId, chain, walletType) key guarantees idempotency.
    const shouldBePrimary =
      options.isPrimary ?? (await this.shouldBePrimary(userId));

    const wallet = await this.prisma.userWallet.upsert({
      where: {
        userId_chain_walletType: { userId, chain, walletType },
      },
      create: {
        userId,
        chain,
        walletType,
        isPrimary: shouldBePrimary,
        creationStatus: WalletCreationStatus.PENDING,
      },
      update: {
        creationStatus: WalletCreationStatus.PENDING,
        creationError: null,
      },
    });

    await this.queue.add(
      USER_WALLET_JOB,
      { walletId: wallet.id, idempotencyKey } satisfies UserWalletJobData,
      {
        jobId: `user-wallet:${wallet.id}:${idempotencyKey}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    this.logger.log(
      `Enqueued wallet creation for user ${userId} (chain=${chain}, type=${walletType})`,
    );
  }

  /**
   * Reconcile a user toward the desired state: a DEVELOPER_CONTROLLED
   * wallet on every active chain (ACTIVE_CHAINS). Idempotent — only the
   * missing chains are enqueued, so this is safe to call on every login.
   *
   * Because it iterates listActiveChains(), adding a new supported chain
   * (registry + env) needs no code change here: the next time a user
   * registers, logs in, or buys, the gap is filled automatically.
   *
   * The default chain's wallet is pinned primary, but only when the user
   * has no wallet yet — an existing primary is never demoted. Admins are
   * skipped (they don't transact on-chain).
   */
  async ensureWalletsForActiveChains(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user || user.role === UserRole.ADMIN) return;

    const existing = await this.prisma.userWallet.findMany({
      where: { userId, walletType: WalletType.DEVELOPER_CONTROLLED },
      select: { chain: true },
    });
    const have = new Set(existing.map((w) => w.chain));
    const startsEmpty = existing.length === 0;
    const defaultChainId = getDefaultChain().id;

    for (const chain of listActiveChains()) {
      if (have.has(chain.id)) continue;
      await this.enqueueWalletCreation(userId, {
        chain: chain.id,
        walletType: WalletType.DEVELOPER_CONTROLLED,
        isPrimary: startsEmpty && chain.id === defaultChainId,
      });
    }
  }

  /**
   * Admin-facing retry. Takes a userId and optionally a chain; defaults
   * to the first FAILED wallet for that user. No-ops on wallets that
   * are already CREATED or PENDING.
   */
  async retryWalletCreation(
    userId: string,
    chain?: string,
  ): Promise<{ status: string; walletId?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      return { status: 'skipped_admin' };
    }

    const wallet = chain
      ? await this.prisma.userWallet.findFirst({
          where: { userId, chain },
        })
      : await this.prisma.userWallet.findFirst({
          where: { userId, creationStatus: WalletCreationStatus.FAILED },
          orderBy: { createdAt: 'asc' },
        });

    if (!wallet) {
      throw new NotFoundException(
        chain
          ? `No wallet for user on chain ${chain}`
          : 'No FAILED wallet to retry',
      );
    }

    if (wallet.circleWalletId) {
      return { status: 'already_created', walletId: wallet.id };
    }
    if (wallet.creationStatus === WalletCreationStatus.PENDING) {
      return { status: 'already_pending', walletId: wallet.id };
    }

    await this.enqueueWalletCreation(userId, {
      chain: wallet.chain,
      walletType: wallet.walletType,
      isPrimary: wallet.isPrimary,
    });
    return { status: 'retry_enqueued', walletId: wallet.id };
  }

  private async shouldBePrimary(userId: string): Promise<boolean> {
    const existing = await this.prisma.userWallet.count({ where: { userId } });
    return existing === 0;
  }
}
