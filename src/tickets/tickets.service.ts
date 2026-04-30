import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EventStatus,
  PaymentProvider,
  Prisma,
  TicketStatus,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { ConfigService } from '@nestjs/config';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { DEFAULT_FEE_BEARER, PLATFORM_FEE_RATE } from '../payments/constants';
import type { PaymentSplit } from '../payments/interfaces/payment-provider.interface';
import {
  generateTicketReference,
  generateTransactionReference,
} from './utils/reference';

interface PurchaseContext {
  buyerId?: string;
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);
  private readonly checkoutCallbackUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    configService: ConfigService,
  ) {
    // Where the gateway redirects after checkout. For local dev this
    // is fine as a relative-ish URL; staging/prod override via env.
    this.checkoutCallbackUrl =
      configService.get<string>('app.paymentCallbackUrl') ??
      'http://localhost:3000/api/payments/callback';
  }

  async purchase(dto: PurchaseTicketDto, ctx: PurchaseContext = {}) {
    const event = await this.prisma.event.findUnique({
      where: { id: dto.eventId },
      include: {
        ticketTypes: { where: { id: dto.ticketTypeId } },
        organizer: {
          include: { organizerProfile: true },
        },
      },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.status !== EventStatus.PUBLISHED) {
      throw new BadRequestException('Event is not open for sales');
    }

    // Country-aware provider eligibility — buyer can't pick a provider
    // that doesn't serve this event's country, and crypto can't be
    // chosen for events that opted out. Crypto + Blockradar both go
    // through the acceptsCrypto gate.
    this.payments.assertEligible(
      {
        country: event.country,
        currency: event.currency,
        acceptsCrypto: event.acceptsCrypto,
      },
      dto.paymentProvider,
    );

    const ticketType = event.ticketTypes[0];
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found for this event');
    }

    const now = new Date();
    if (event.purchaseStartTime && now < event.purchaseStartTime) {
      throw new BadRequestException('Sales have not started yet');
    }
    if (now >= event.startTime) {
      throw new BadRequestException('Sales window has closed');
    }

    if (ticketType.salesStartDate && now < ticketType.salesStartDate) {
      throw new BadRequestException(
        'Sales for this ticket type have not started',
      );
    }
    if (ticketType.salesEndDate && now >= ticketType.salesEndDate) {
      throw new BadRequestException('Sales for this ticket type have ended');
    }

    if (ticketType.soldCount + dto.quantity > ticketType.quantity) {
      throw new BadRequestException(
        `Only ${ticketType.quantity - ticketType.soldCount} ticket(s) remaining`,
      );
    }

    // Per-user limit. Authenticated buyers are tracked by buyerId so
    // they can't bypass the cap by changing email; guests fall back to
    // (eventId + buyerEmail) on the same ticket type.
    const existingForBuyer = await this.prisma.ticket.count({
      where: {
        ticketTypeId: ticketType.id,
        status: { not: TicketStatus.CANCELLED },
        ...(ctx.buyerId
          ? { buyerId: ctx.buyerId }
          : { buyerId: null, buyerEmail: dto.buyerEmail }),
      },
    });
    if (existingForBuyer + dto.quantity > ticketType.maxPerUser) {
      throw new BadRequestException(
        `Per-buyer limit is ${ticketType.maxPerUser} for this ticket type`,
      );
    }

    const totalAmount = new Prisma.Decimal(ticketType.price).mul(dto.quantity);
    const transactionReference = generateTransactionReference();
    const ticketReferences = Array.from(
      { length: dto.quantity },
      generateTicketReference,
    );

    // Compute the 97/3 split from gross. Done in Decimal to avoid
    // floating-point drift on naira/kobo boundaries; rounded to 2
    // decimals (NGN minor unit) and the organizer absorbs any rounding
    // remainder so HostIT's cut is the deterministic figure.
    const platformFee = totalAmount
      .mul(PLATFORM_FEE_RATE)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const organizerAmount = totalAmount.sub(platformFee);

    // Resolve the organizer's split-routing target for this provider.
    // Missing subaccount = we fall back to no-split (full amount lands
    // in HostIT's account) and log a warning so ops can backfill.
    const split = this.resolveSplit(
      dto.paymentProvider,
      event.organizer?.organizerProfile,
      platformFee,
    );

    // Atomically reserve inventory, create the transaction shell, and
    // create the tickets. Optimistic concurrency: if `soldCount`
    // changed between the read above and our increment, the WHERE
    // clause filters us out and we retry / fail clearly.
    const { transaction, tickets } = await this.prisma.$transaction(
      async (tx) => {
        const reserved = await tx.ticketType.updateMany({
          where: {
            id: ticketType.id,
            soldCount: ticketType.soldCount,
          },
          data: { soldCount: { increment: dto.quantity } },
        });
        if (reserved.count === 0) {
          throw new ConflictException(
            'Inventory changed during purchase, please retry',
          );
        }

        const isFree = event.isFree || ticketType.price.equals(0);

        const transaction = await tx.transaction.create({
          data: {
            reference: transactionReference,
            quantity: dto.quantity,
            eventId: event.id,
            buyerEmail: dto.buyerEmail,
            amount: totalAmount,
            currency: 'NGN',
            provider: dto.paymentProvider,
            // Free events skip the gateway entirely; record the txn as
            // SUCCESS so the tickets can be confirmed in the same write.
            status: isFree
              ? TransactionStatus.SUCCESS
              : TransactionStatus.PENDING,
            // Lock in the split at init so the invoice ledger reflects
            // exactly what we asked the gateway to do, even if commercial
            // terms or the platform rate change later.
            platformFee: isFree ? new Prisma.Decimal(0) : platformFee,
            organizerAmount: isFree ? new Prisma.Decimal(0) : organizerAmount,
            feeBearer: DEFAULT_FEE_BEARER,
          },
        });

        await tx.ticket.createMany({
          data: ticketReferences.map((reference) => ({
            ticketTypeId: ticketType.id,
            eventId: event.id,
            transactionId: transaction.id,
            buyerId: ctx.buyerId ?? null,
            buyerEmail: dto.buyerEmail,
            buyerName: dto.buyerName,
            buyerPhone: dto.buyerPhone ?? null,
            reference,
            deliveryChannel: dto.deliveryChannel,
            status: isFree ? TicketStatus.CONFIRMED : TicketStatus.PENDING,
          })),
        });

        const tickets = await tx.ticket.findMany({
          where: { transactionId: transaction.id },
          select: { id: true, reference: true, status: true },
        });

        return { transaction, tickets };
      },
    );

    // Free event short-circuit — no gateway round-trip.
    if (transaction.status === TransactionStatus.SUCCESS) {
      return {
        reference: transaction.reference,
        checkoutUrl: null,
        amount: Number(totalAmount),
        currency: 'NGN',
        provider: dto.paymentProvider,
        tickets,
        free: true,
      };
    }

    // Hand off to the payment provider. If this throws we leave the
    // transaction PENDING — the buyer can retry, and a future cron
    // can sweep abandoned PENDING transactions back to FAILED.
    const init = await this.payments.initializePayment(dto.paymentProvider, {
      amount: Number(totalAmount),
      email: dto.buyerEmail,
      reference: transaction.reference,
      callbackUrl: this.checkoutCallbackUrl,
      metadata: {
        eventId: event.id,
        eventName: event.name,
        ticketTypeId: ticketType.id,
        ticketTypeName: ticketType.name,
        quantity: dto.quantity,
        ticketReferences,
      },
      split: split ?? undefined,
    });

    return {
      reference: transaction.reference,
      checkoutUrl: init.checkoutUrl,
      providerReference: init.providerReference,
      amount: Number(totalAmount),
      platformFee: Number(platformFee),
      organizerAmount: Number(organizerAmount),
      currency: 'NGN',
      provider: dto.paymentProvider,
      tickets,
      free: false,
    };
  }

  /**
   * Picks the right subaccount code for the requested provider and
   * builds a `PaymentSplit`. Returns null when split routing isn't
   * available — the caller will fall back to single-account settlement
   * and we log a warning so ops can backfill the organizer's
   * subaccounts.
   */
  private resolveSplit(
    provider: PaymentProvider,
    profile:
      | {
          paystackSubaccountCode: string | null;
          monnifySubAccountCode: string | null;
        }
      | null
      | undefined,
    platformFee: Prisma.Decimal,
  ): PaymentSplit | null {
    if (!profile) return null;

    const subaccountCode =
      provider === PaymentProvider.PAYSTACK
        ? profile.paystackSubaccountCode
        : provider === PaymentProvider.MONNIFY
          ? profile.monnifySubAccountCode
          : null;

    if (!subaccountCode) {
      this.logger.warn(
        `Organizer has no ${provider} subaccount — funds will route to platform account; backfill required`,
      );
      return null;
    }

    return {
      subaccountCode,
      platformAmount: Number(platformFee),
      feeBearer: DEFAULT_FEE_BEARER,
    };
  }
}
