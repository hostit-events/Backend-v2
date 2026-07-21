import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EventStatus,
  PaymentProvider,
  PayoutStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainReadService } from '../blockchain/blockchain-read.service';
import { PayoutQueueService } from '../blockchain/payout-queue.service';
import { FEE_TYPE_USDC, USDC_DECIMALS } from '../blockchain/onchain-fees';
import { QueryPayoutsDto } from './dto/query-payouts.dto';

const USDC_SCALE = new Prisma.Decimal(10).pow(USDC_DECIMALS);

/** Statuses that block a new payout request / count as outstanding. */
const ACTIVE_PAYOUT_STATUSES: PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.PROCESSING,
];

type PayoutWithEvent = Prisma.PayoutGetPayload<{
  include: { event: { select: { name: true } } };
}>;

/**
 * Organizer payouts (#46). Crypto-only in this slice: a payout withdraws
 * the event's on-chain USDC escrow to the organizer's Circle wallet via
 * the #37 payout engine.
 *
 * Fiat revenue is already settled to the organizer's bank at purchase
 * time via Paystack/Monnify split subaccounts, so it never surfaces here
 * — only escrowed refundable-crypto revenue is withdrawable.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly read: BlockchainReadService,
    private readonly payoutQueue: PayoutQueueService,
  ) {}

  /**
   * Request a payout for an event. Validates ownership, status, the
   * on-chain refund window, and duplicate requests, then fans out one
   * on-chain withdraw per ticket type that still holds escrow.
   */
  async requestPayout(organizerId: string, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        organizerId: true,
        status: true,
        endTime: true,
        chain: true,
        ticketTypes: {
          select: { id: true, onChainTicketId: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You do not own this event');
    }
    if (
      event.status !== EventStatus.PUBLISHED &&
      event.status !== EventStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'Payouts are only available for published or completed events',
      );
    }

    // Refund/withdraw window: the Diamond rejects withdrawTicketBalance
    // until the refund period after event end has elapsed. Pre-check here
    // so the organizer gets a clear error instead of a failed job.
    const refundPeriodSecs = await this.read.getRefundPeriod(event.chain);
    const withdrawableAt = new Date(
      event.endTime.getTime() + Number(refundPeriodSecs) * 1000,
    );
    if (Date.now() < withdrawableAt.getTime()) {
      throw new BadRequestException(
        `Refund period has not elapsed; payout available after ${withdrawableAt.toISOString()}`,
      );
    }

    const existing = await this.prisma.payout.findFirst({
      where: { eventId, status: { in: ACTIVE_PAYOUT_STATUSES } },
    });
    if (existing) {
      throw new BadRequestException(
        'A payout for this event is already pending or processing',
      );
    }

    // Read live escrow per published ticket type; only withdraw the ones
    // that actually hold a balance.
    const onchainTypes = event.ticketTypes.filter(
      (t): t is { id: string; onChainTicketId: bigint } =>
        t.onChainTicketId !== null,
    );
    const withdrawable: { ticketTypeId: string; balance: bigint }[] = [];
    let totalRaw = 0n;
    for (const t of onchainTypes) {
      const balance = await this.read.getTicketBalance(
        event.chain,
        t.onChainTicketId,
        FEE_TYPE_USDC,
      );
      if (balance > 0n) {
        withdrawable.push({ ticketTypeId: t.id, balance });
        totalRaw += balance;
      }
    }

    if (totalRaw === 0n) {
      throw new BadRequestException(
        'No withdrawable on-chain balance for this event (funds may have already been settled at purchase)',
      );
    }

    const amount = new Prisma.Decimal(totalRaw.toString()).div(USDC_SCALE);

    // Create the payout record, fan out the withdraws, then flip to
    // PROCESSING. The finalizer closes it to COMPLETED once escrow is
    // fully drained.
    const payout = await this.prisma.payout.create({
      data: {
        organizerId,
        eventId,
        amount,
        currency: 'USDC',
        provider: PaymentProvider.CRYPTO,
        status: PayoutStatus.PENDING,
        scheduledDate: new Date(),
      },
      include: { event: { select: { name: true } } },
    });

    for (const w of withdrawable) {
      await this.payoutQueue.enqueuePayout(w.ticketTypeId, eventId);
    }

    const processing = await this.prisma.payout.update({
      where: { id: payout.id },
      data: { status: PayoutStatus.PROCESSING },
      include: { event: { select: { name: true } } },
    });

    this.logger.log(
      `Payout requested (event=${eventId}, payout=${payout.id}, amount=${amount.toString()} USDC, withdraws=${withdrawable.length})`,
    );

    return {
      ...this.toDto(processing),
      message: 'Payout request submitted. Withdrawing on-chain now.',
    };
  }

  /** Paginated payout history for the organizer, with an all-time summary. */
  async getPayoutHistory(organizerId: string, query: QueryPayoutsDto) {
    const where: Prisma.PayoutWhereInput = {
      organizerId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [payouts, total, paidAgg, pendingAgg, totalPayouts] =
      await this.prisma.$transaction([
        this.prisma.payout.findMany({
          where,
          include: { event: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.limit,
        }),
        this.prisma.payout.count({ where }),
        this.prisma.payout.aggregate({
          where: { organizerId, status: PayoutStatus.COMPLETED },
          _sum: { amount: true },
        }),
        this.prisma.payout.aggregate({
          where: { organizerId, status: { in: ACTIVE_PAYOUT_STATUSES } },
          _sum: { amount: true },
        }),
        this.prisma.payout.count({ where: { organizerId } }),
      ]);

    return {
      payouts: payouts.map((p) => this.toDto(p)),
      summary: {
        totalPaid: (paidAgg._sum.amount ?? new Prisma.Decimal(0)).toString(),
        pendingAmount: (
          pendingAgg._sum.amount ?? new Prisma.Decimal(0)
        ).toString(),
        totalPayouts,
      },
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ---------- internals ----------

  private toDto(p: PayoutWithEvent) {
    return {
      id: p.id,
      eventId: p.eventId,
      eventName: p.event.name,
      amount: p.amount.toString(),
      currency: p.currency,
      provider: p.provider,
      status: p.status,
      providerReference: p.providerReference,
      scheduledDate: p.scheduledDate,
      processedAt: p.processedAt,
      createdAt: p.createdAt,
    };
  }
}
