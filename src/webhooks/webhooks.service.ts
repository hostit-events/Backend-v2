import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentProvider,
  TicketStatus,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MintQueueService } from '../blockchain/mint-queue.service';

interface SuccessInput {
  reference: string;
  provider: PaymentProvider;
  providerReference: string;
  amount: number; // NGN
  channel?: string;
  paidAt?: Date;
}

interface FailureInput {
  reference: string;
  provider: PaymentProvider;
}

/**
 * Shared webhook processor. Every provider's webhook controller funnels
 * into one of these two methods so behaviour stays consistent.
 *
 * Idempotency rule: a transaction already in a terminal state
 * (SUCCESS/FAILED) is left alone — re-delivered webhooks are a no-op.
 * This means we can return 200 OK for duplicates without re-running
 * mint enqueues or `soldCount` decrements.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mintQueue: MintQueueService,
  ) {}

  async handleSuccess(input: SuccessInput): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { reference: input.reference },
    });

    if (!transaction) {
      this.logger.warn(
        `Webhook for unknown reference=${input.reference} provider=${input.provider} — ignoring`,
      );
      return;
    }

    if (transaction.status !== TransactionStatus.PENDING) {
      this.logger.log(
        `Webhook ignored — transaction ${transaction.id} already in ${transaction.status}`,
      );
      return;
    }

    const tickets = await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.SUCCESS,
          providerReference: input.providerReference,
          metadata: {
            ...(transaction.metadata as Record<string, any> | null),
            channel: input.channel,
            paidAt: input.paidAt?.toISOString(),
            confirmedAmount: input.amount,
          },
        },
      });

      // Tickets stay PENDING until the on-chain mint confirms.
      // The mint queue worker (Phase 6) flips them to CONFIRMED.
      return tx.ticket.findMany({
        where: { transactionId: transaction.id },
        select: { id: true, eventId: true },
      });
    });

    for (const t of tickets) {
      await this.mintQueue.enqueueMint(t.id, t.eventId);
    }
  }

  async handleFailure(input: FailureInput): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { reference: input.reference },
    });

    if (!transaction) {
      this.logger.warn(
        `Failure webhook for unknown reference=${input.reference} — ignoring`,
      );
      return;
    }

    if (transaction.status !== TransactionStatus.PENDING) {
      this.logger.log(
        `Failure webhook ignored — transaction ${transaction.id} already in ${transaction.status}`,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.FAILED },
      });

      const tickets = await tx.ticket.findMany({
        where: { transactionId: transaction.id },
        select: { id: true, ticketTypeId: true, status: true },
      });

      // Group decrements by ticketType so a single update handles all
      // seats of the same tier. Cancelled tickets are skipped so a
      // re-delivered failure webhook can't double-release inventory.
      const decrementsByType = new Map<string, number>();
      for (const t of tickets) {
        if (t.status === TicketStatus.CANCELLED) continue;
        decrementsByType.set(
          t.ticketTypeId,
          (decrementsByType.get(t.ticketTypeId) ?? 0) + 1,
        );
      }

      const liveIds = tickets
        .filter((t) => t.status !== TicketStatus.CANCELLED)
        .map((t) => t.id);
      if (liveIds.length > 0) {
        await tx.ticket.updateMany({
          where: { id: { in: liveIds } },
          data: { status: TicketStatus.CANCELLED },
        });
      }

      for (const [ticketTypeId, count] of decrementsByType) {
        await tx.ticketType.update({
          where: { id: ticketTypeId },
          data: { soldCount: { decrement: count } },
        });
      }
    });
  }
}
