import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { UserRole, WalletCreationStatus } from '@prisma/client';
import { CircleService } from '../circle/circle.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  USER_WALLET_JOB,
  USER_WALLET_QUEUE,
  type UserWalletJobData,
} from './wallets.constants';

@Processor(USER_WALLET_QUEUE)
export class UserWalletProcessor extends WorkerHost {
  private readonly logger = new Logger(UserWalletProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleService,
  ) {
    super();
  }

  async process(job: Job<UserWalletJobData>): Promise<void> {
    if (job.name !== USER_WALLET_JOB) {
      this.logger.warn(`Unexpected job name: ${job.name}`);
      return;
    }

    const { walletId, idempotencyKey } = job.data;

    const wallet = await this.prisma.userWallet.findUnique({
      where: { id: walletId },
      include: { user: { select: { id: true, role: true } } },
    });

    if (!wallet) {
      this.logger.warn(`Wallet ${walletId} not found; skipping`);
      return;
    }

    if (wallet.circleWalletId) {
      this.logger.log(
        `Wallet ${walletId} already provisioned; skipping (circleWalletId=${wallet.circleWalletId})`,
      );
      return;
    }

    if (wallet.user.role === UserRole.ADMIN) {
      // Role may have upgraded to ADMIN between enqueue and processing.
      await this.prisma.userWallet.delete({ where: { id: walletId } });
      this.logger.log(
        `User ${wallet.userId} is ADMIN; deleting stub wallet ${walletId}`,
      );
      return;
    }

    try {
      const walletSetId = this.circle.walletSetId;

      const response = await this.circle.client.createWallets({
        accountType: 'SCA',
        blockchains: [wallet.chain as 'BASE-SEPOLIA'],
        count: 1,
        walletSetId,
        idempotencyKey,
      });

      const created = response.data?.wallets?.[0];
      if (!created?.id || !created.address) {
        throw new Error(
          `Circle createWallets returned unexpected shape: ${JSON.stringify(response.data)}`,
        );
      }

      await this.prisma.userWallet.update({
        where: { id: walletId },
        data: {
          circleWalletId: created.id,
          circleWalletSetId: walletSetId,
          address: created.address,
          creationStatus: WalletCreationStatus.CREATED,
          creationError: null,
        },
      });

      this.logger.log(
        `Created wallet for user ${wallet.userId} on ${wallet.chain} (address=${created.address})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await this.prisma.userWallet.update({
        where: { id: walletId },
        data: {
          creationStatus: isFinal
            ? WalletCreationStatus.FAILED
            : WalletCreationStatus.PENDING,
          creationError: message.slice(0, 500),
        },
      });

      this.logger.error(
        `Wallet creation failed for wallet ${walletId} (attempt ${job.attemptsMade + 1}): ${message}`,
      );
      throw error;
    }
  }
}
