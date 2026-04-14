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
    const txn = await this.prisma.transaction.findFirst({
      where: { id: input.reference },
    });

    // Reference may be our generated id OR a provider-generated string we
    // stored under metadata — for now we look it up by id, fall back to
    // metadata search in a single query.
    const transaction =
      txn ??
      (await this.prisma.transaction.findFirst({
        where: { providerReference: input.reference },
      }));

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

    const ticketIds = await this.prisma.$transaction(async (tx) => {
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
      const tickets = await tx.ticket.findMany({
        where: {
          OR: [
            { id: transaction.ticketId ?? undefined },
            { reference: transaction.providerReference ?? undefined },
          ],
        },
        select: { id: true, eventId: true },
      });

      return tickets;
    });

    for (const t of ticketIds) {
      await this.mintQueue.enqueueMint(t.id, t.eventId);
    }
  }

  async handleFailure(input: FailureInput): Promise<void> {
    const transaction = await this.prisma.transaction.findFirst({
      where: {
        OR: [
          { id: input.reference },
          { providerReference: input.reference },
        ],
      },
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

      if (!transaction.ticketId) return;

      const ticket = await tx.ticket.findUnique({
        where: { id: transaction.ticketId },
        select: { id: true, ticketTypeId: true, status: true },
      });
      if (!ticket || ticket.status === TicketStatus.CANCELLED) return;

      await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: TicketStatus.CANCELLED },
      });

      // Release the seat back to inventory.
      await tx.ticketType.update({
        where: { id: ticket.ticketTypeId },
        data: { soldCount: { decrement: 1 } },
      });
    });
  }
}
