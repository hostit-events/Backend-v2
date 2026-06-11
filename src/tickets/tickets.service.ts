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
  UserRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CryptoCheckoutService } from '../payments/crypto-checkout.service';
import { WalletsService } from '../wallets/wallets.service';
import { ConfigService } from '@nestjs/config';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { QueryMyTicketsDto } from './dto/query-my-tickets.dto';
import { DEFAULT_FEE_BEARER, PLATFORM_FEE_RATE } from '../payments/constants';
import type { PaymentSplit } from '../payments/interfaces/payment-provider.interface';
import {
  generateTicketReference,
  generateTransactionReference,
} from './utils/reference';

interface PurchaseContext {
  buyerId?: string;
}

/**
 * Relations + columns hydrated for the ticket-detail responses
 * (GET /tickets/mine and GET /tickets/:reference). Buyer email/phone
 * are deliberately NOT selected on the nested relations — the public
 * by-reference response must never leak them.
 */
const TICKET_DETAIL_INCLUDE = {
  ticketType: { select: { name: true, description: true, price: true } },
  event: {
    select: {
      id: true,
      name: true,
      slug: true,
      venue: true,
      location: true,
      startTime: true,
      endTime: true,
      coverImage: true,
      organizer: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.TicketInclude;

type TicketWithDetail = Prisma.TicketGetPayload<{
  include: typeof TICKET_DETAIL_INCLUDE;
}>;

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);
  private readonly checkoutCallbackUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly cryptoCheckout: CryptoCheckoutService,
    private readonly wallets: WalletsService,
    configService: ConfigService,
  ) {
    // Where the gateway redirects after checkout. For local dev this
    // is fine as a relative-ish URL; staging/prod override via env.
    this.checkoutCallbackUrl =
      configService.get<string>('app.paymentCallbackUrl') ??
      'http://localhost:3000/api/payments/callback';
  }

  /**
   * Tickets belonging to the authenticated buyer, newest first, with
   * optional status / event filters. Returns an empty list (never an
   * error) when the buyer has no tickets.
   */
  async findMyTickets(buyerId: string, query: QueryMyTicketsDto) {
    const where: Prisma.TicketWhereInput = { buyerId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.eventId) {
      where.eventId = query.eventId;
    }

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: TICKET_DETAIL_INCLUDE,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return {
      tickets: tickets.map((ticket) => this.serializeTicket(ticket)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * Public ticket lookup by reference — backs QR codes, email links and
   * confirmation pages. Exposes buyer name (needed for door checks) and
   * the organizer name, but never buyer email/phone.
   */
  async findByReference(reference: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { reference },
      include: TICKET_DETAIL_INCLUDE,
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    return this.serializeTicket(ticket, {
      includeBuyer: true,
      includeOrganizer: true,
    });
  }

  /**
   * Shared ticket response shape for the detail endpoints. `includeBuyer`
   * adds the buyer name; `includeOrganizer` adds the organizer name —
   * both used by the public by-reference response, omitted from a
   * buyer's own list.
   */
  private serializeTicket(
    ticket: TicketWithDetail,
    opts: { includeBuyer?: boolean; includeOrganizer?: boolean } = {},
  ) {
    return {
      id: ticket.id,
      reference: ticket.reference,
      status: ticket.status,
      ...(opts.includeBuyer ? { buyerName: ticket.buyerName } : {}),
      qrCode: ticket.qrCode,
      tokenId: ticket.tokenId,
      deliveryChannel: ticket.deliveryChannel,
      checkedInAt: ticket.checkedInAt,
      createdAt: ticket.createdAt,
      ticketType: {
        name: ticket.ticketType.name,
        description: ticket.ticketType.description,
        price: Number(ticket.ticketType.price),
      },
      event: {
        id: ticket.event.id,
        name: ticket.event.name,
        slug: ticket.event.slug,
        venue: ticket.event.venue,
        location: ticket.event.location,
        startTime: ticket.event.startTime,
        endTime: ticket.event.endTime,
        coverImage: ticket.event.coverImage,
        ...(opts.includeOrganizer
          ? {
              organizer: {
                firstName: ticket.event.organizer.firstName,
                lastName: ticket.event.organizer.lastName,
              },
            }
          : {}),
      },
    };
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
    // that doesn't serve this event's country, can't pick crypto for
    // events that opted out, and can't pick a fiat provider the
    // organizer hasn't completed enable for.
    const profile = event.organizer.organizerProfile;
    const enabledFiatProviders: PaymentProvider[] = [];
    if (profile?.paystackSubaccountCode) {
      enabledFiatProviders.push(PaymentProvider.PAYSTACK);
    }
    if (profile?.monnifySubAccountCode) {
      enabledFiatProviders.push(PaymentProvider.MONNIFY);
    }
    this.payments.assertEligible(
      {
        country: event.country,
        currency: event.currency,
        acceptsCrypto: event.acceptsCrypto,
        enabledFiatProviders,
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

    // Guest checkout still produces a User row so the mint worker has a
    // wallet to mint into. Authenticated buyers pass through unchanged;
    // unauthenticated buyers are upserted by email and a Circle wallet
    // creation is enqueued on the event's chain.
    const buyerId =
      ctx.buyerId ??
      (await this.findOrCreateGuestBuyer({
        email: dto.buyerEmail,
        name: dto.buyerName,
        phone: dto.buyerPhone,
        chain: event.chain,
      }));

    // Per-buyer cap. Now keyed off buyerId for everyone (guest or auth)
    // since the guest upsert above attaches every purchase to a stable
    // User row.
    const existingForBuyer = await this.prisma.ticket.count({
      where: {
        ticketTypeId: ticketType.id,
        status: { not: TicketStatus.CANCELLED },
        buyerId,
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
            buyerId,
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

    // Crypto checkout — no gateway redirect. Return a USDC deposit
    // instruction; the `transactions.inbound` webhook settles the
    // transaction and triggers minting (see CircleWebhookProcessor).
    if (dto.paymentProvider === PaymentProvider.CRYPTO) {
      const deposit = await this.cryptoCheckout.createDepositIntent({
        transactionId: transaction.id,
        buyerId,
        chain: event.chain,
        amountNgn: totalAmount,
      });
      return {
        reference: transaction.reference,
        checkoutUrl: null,
        amount: Number(totalAmount),
        currency: 'NGN',
        provider: dto.paymentProvider,
        tickets,
        free: false,
        crypto: deposit,
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

  /**
   * Find a User by email; create a placeholder BUYER record if none
   * exists. Wallet creation is enqueued on the event's chain so the
   * mint worker has somewhere to mint into when the payment confirms.
   *
   * The placeholder user has a random unguessable password — the
   * guest can claim the account later by running the forgot-password
   * flow against their email, which sets a real password.
   */
  private async findOrCreateGuestBuyer(input: {
    email: string;
    name: string;
    phone?: string;
    chain: string;
  }): Promise<string> {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) return existing.id;

    const placeholderPassword = await bcrypt.hash(
      randomBytes(32).toString('hex'),
      10,
    );
    const [firstName, ...rest] = input.name.trim().split(/\s+/);
    const lastName = rest.join(' ') || '';

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        password: placeholderPassword,
        firstName: firstName || 'Guest',
        lastName,
        phone: input.phone,
        role: UserRole.BUYER,
      },
    });

    // Provision a wallet on the event's chain. The mint worker will
    // retry with backoff if the wallet isn't ready yet — we don't
    // block the purchase response on Circle availability.
    try {
      await this.wallets.enqueueWalletCreation(user.id, {
        chain: input.chain,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue guest wallet for user ${user.id}: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Auto-provisioned guest buyer userId=${user.id} email=${input.email}`,
    );
    return user.id;
  }
}
