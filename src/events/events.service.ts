import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';
import {
  EventStatus,
  BlockchainTxType,
  BlockchainTxStatus,
  Prisma,
} from '@prisma/client';
import * as crypto from 'crypto';
import { computeUsdcFees } from '../blockchain/onchain-fees';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('event-publish') private readonly eventPublishQueue: Queue,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {}

  async create(organizerId: string, dto: CreateEventDto) {
    // Organizers can create events immediately — crypto payments are always
    // available, so no KYC is required up front. KYC + bank verification are
    // enforced just-in-time when an organizer enables a fiat provider for a
    // country (see OrganizerService.enablePaystack / .enableMonnify), NOT at
    // event creation. We only assert the organizer profile exists; the route
    // is already guarded by @Roles(ORGANIZER), and becomeOrganizer always
    // creates this row alongside the role grant.
    const profile = await this.prisma.organizerProfile.findUnique({
      where: { userId: organizerId },
    });

    if (!profile) {
      throw new ForbiddenException(
        'Organizer profile missing — call /auth/become-organizer first',
      );
    }

    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    const purchaseStartTime = new Date(dto.purchaseStartTime);
    const now = new Date();

    // startTime must be > now + 24 hours
    const minStartTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (startTime <= minStartTime) {
      throw new BadRequestException(
        'Event start time must be at least 24 hours from now',
      );
    }

    // endTime must be >= startTime + 1 day
    const minEndTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
    if (endTime < minEndTime) {
      throw new BadRequestException(
        'Event end time must be at least 1 day after start time',
      );
    }

    // purchaseStartTime must be <= startTime - 1 day
    const maxPurchaseStart = new Date(
      startTime.getTime() - 24 * 60 * 60 * 1000,
    );
    if (purchaseStartTime > maxPurchaseStart) {
      throw new BadRequestException(
        'Purchase start time must be at least 1 day before event start',
      );
    }

    // If isFree, all ticket prices must be 0
    if (dto.isFree) {
      const hasNonZeroPrice = dto.ticketTypes.some((tt) => tt.price !== 0);
      if (hasNonZeroPrice) {
        throw new BadRequestException(
          'All ticket prices must be 0 for free events',
        );
      }
    } else {
      // Non-free events: prices must be >= 500
      const hasInvalidPrice = dto.ticketTypes.some(
        (tt) => tt.price > 0 && tt.price < 500,
      );
      if (hasInvalidPrice) {
        throw new BadRequestException(
          'Ticket prices for paid events must be at least 500 NGN',
        );
      }
    }

    const slug = await this.generateUniqueSlug(dto.name);

    const event = await this.prisma.event.create({
      data: {
        organizerId,
        name: dto.name,
        slug,
        description: dto.description,
        venue: dto.venue,
        location: dto.location,
        category: dto.category,
        coverImage: dto.coverImage,
        startTime,
        endTime,
        purchaseStartTime,
        isFree: dto.isFree ?? false,
        isRefundable: dto.isRefundable ?? false,
        ticketTypes: {
          create: dto.ticketTypes.map((tt) => ({
            name: tt.name,
            description: tt.description,
            price: tt.price,
            quantity: tt.quantity,
            maxPerUser: tt.maxPerUser ?? 5,
            salesStartDate: tt.salesStartDate
              ? new Date(tt.salesStartDate)
              : undefined,
            salesEndDate: tt.salesEndDate
              ? new Date(tt.salesEndDate)
              : undefined,
          })),
        },
      },
      include: {
        ticketTypes: true,
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    this.logger.log(`Event created: ${event.name} (${event.slug})`);

    return event;
  }

  async findAll(query: QueryEventsDto) {
    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
    };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.category) {
      where.category = query.category;
    }

    if (query.location) {
      where.location = { contains: query.location, mode: 'insensitive' };
    }

    if (query.isFree !== undefined) {
      where.isFree = query.isFree;
    }

    if (query.startDate || query.endDate) {
      where.startTime = {};
      if (query.startDate) {
        where.startTime.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        where.startTime.lte = new Date(query.endDate);
      }
    }

    const orderBy: Prisma.EventOrderByWithRelationInput = {
      [query.sort || 'startTime']: query.order || 'asc',
    };

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
        include: {
          ticketTypes: {
            select: {
              name: true,
              price: true,
              quantity: true,
              soldCount: true,
            },
          },
          organizer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      this.prisma.event.count({ where }),
    ]);

    const eventsWithStats = events.map((event) => {
      const prices = event.ticketTypes.map((tt) => Number(tt.price));
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
      const totalAvailable = event.ticketTypes.reduce(
        (sum, tt) => sum + (tt.quantity - tt.soldCount),
        0,
      );

      return {
        ...event,
        minPrice,
        totalAvailable,
      };
    });

    return {
      events: eventsWithStats,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // Lists the calling organizer's DRAFT events (the ones still awaiting
  // publish). Scoped to organizerId so an organizer only ever sees their
  // own drafts. Newest first, with the same minPrice/totalAvailable stats
  // findAll returns for UI consistency.
  async findMyDrafts(organizerId: string) {
    const events = await this.prisma.event.findMany({
      where: { organizerId, status: EventStatus.DRAFT },
      orderBy: { createdAt: 'desc' },
      include: { ticketTypes: true },
    });

    return events.map((event) => {
      const prices = event.ticketTypes.map((tt) => Number(tt.price));
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
      const totalAvailable = event.ticketTypes.reduce(
        (sum, tt) => sum + (tt.quantity - tt.soldCount),
        0,
      );

      return { ...event, minPrice, totalAvailable };
    });
  }

  async update(eventId: string, organizerId: string, dto: UpdateEventDto) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You can only update your own events');
    }

    if (event.status !== EventStatus.DRAFT) {
      throw new ForbiddenException('Only DRAFT events can be updated');
    }

    // Validate time constraints using provided or existing values
    const startTime = dto.startTime ? new Date(dto.startTime) : event.startTime;
    const endTime = dto.endTime ? new Date(dto.endTime) : event.endTime;
    const purchaseStartTime = dto.purchaseStartTime
      ? new Date(dto.purchaseStartTime)
      : event.purchaseStartTime;

    const now = new Date();
    const minStartTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (startTime <= minStartTime) {
      throw new BadRequestException(
        'Event start time must be at least 24 hours from now',
      );
    }

    const minEndTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
    if (endTime < minEndTime) {
      throw new BadRequestException(
        'Event end time must be at least 1 day after start time',
      );
    }

    const maxPurchaseStart = new Date(
      startTime.getTime() - 24 * 60 * 60 * 1000,
    );
    if (purchaseStartTime > maxPurchaseStart) {
      throw new BadRequestException(
        'Purchase start time must be at least 1 day before event start',
      );
    }

    // Regenerate slug if name changed
    let slug = event.slug;
    if (dto.name && dto.name !== event.name) {
      slug = await this.generateUniqueSlug(dto.name);
    }

    // Free event price validation
    const isFree = dto.isFree ?? event.isFree;
    if (dto.ticketTypes) {
      if (isFree) {
        const hasNonZeroPrice = dto.ticketTypes.some((tt) => tt.price !== 0);
        if (hasNonZeroPrice) {
          throw new BadRequestException(
            'All ticket prices must be 0 for free events',
          );
        }
      } else {
        const hasInvalidPrice = dto.ticketTypes.some(
          (tt) => tt.price > 0 && tt.price < 500,
        );
        if (hasInvalidPrice) {
          throw new BadRequestException(
            'Ticket prices for paid events must be at least 500 NGN',
          );
        }
      }
    }

    // Handle ticket type updates in a transaction
    const updatedEvent = await this.prisma.$transaction(async (tx) => {
      // Handle ticket types if provided
      if (dto.ticketTypes) {
        const incomingIds = dto.ticketTypes
          .filter((tt) => tt.id)
          .map((tt) => tt.id!);

        // Find ticket types to delete (existing but not in incoming)
        const toDelete = event.ticketTypes.filter(
          (tt) => !incomingIds.includes(tt.id),
        );

        // Check if any to-delete types have sales
        const hasActiveSales = toDelete.some((tt) => tt.soldCount > 0);
        if (hasActiveSales) {
          throw new BadRequestException(
            'Cannot remove ticket types that have sales',
          );
        }

        // Delete removed ticket types
        if (toDelete.length > 0) {
          await tx.ticketType.deleteMany({
            where: { id: { in: toDelete.map((tt) => tt.id) } },
          });
        }

        // Upsert ticket types
        for (const tt of dto.ticketTypes) {
          if (tt.id) {
            await tx.ticketType.update({
              where: { id: tt.id },
              data: {
                name: tt.name,
                description: tt.description,
                price: tt.price,
                quantity: tt.quantity,
                maxPerUser: tt.maxPerUser ?? 5,
                salesStartDate: tt.salesStartDate
                  ? new Date(tt.salesStartDate)
                  : null,
                salesEndDate: tt.salesEndDate
                  ? new Date(tt.salesEndDate)
                  : null,
              },
            });
          } else {
            await tx.ticketType.create({
              data: {
                eventId,
                name: tt.name,
                description: tt.description,
                price: tt.price,
                quantity: tt.quantity,
                maxPerUser: tt.maxPerUser ?? 5,
                salesStartDate: tt.salesStartDate
                  ? new Date(tt.salesStartDate)
                  : undefined,
                salesEndDate: tt.salesEndDate
                  ? new Date(tt.salesEndDate)
                  : undefined,
              },
            });
          }
        }
      }

      // Update event fields
      return tx.event.update({
        where: { id: eventId },
        data: {
          ...(dto.name && { name: dto.name }),
          slug,
          ...(dto.description && { description: dto.description }),
          ...(dto.venue && { venue: dto.venue }),
          ...(dto.location && { location: dto.location }),
          ...(dto.category && { category: dto.category }),
          ...(dto.coverImage !== undefined && { coverImage: dto.coverImage }),
          ...(dto.startTime && { startTime }),
          ...(dto.endTime && { endTime }),
          ...(dto.purchaseStartTime && { purchaseStartTime }),
          ...(dto.isFree !== undefined && { isFree: dto.isFree }),
          ...(dto.isRefundable !== undefined && {
            isRefundable: dto.isRefundable,
          }),
        },
        include: {
          ticketTypes: true,
          organizer: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });
    });

    this.logger.log(
      `Event updated: ${updatedEvent.name} (${updatedEvent.slug})`,
    );
    return updatedEvent;
  }

  async publish(eventId: string, organizerId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        ticketTypes: true,
        organizer: { include: { organizerProfile: true } },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You can only publish your own events');
    }

    if (event.status !== EventStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT events can be published');
    }

    // JIT-KYC gate: an event must reach buyers via at least one
    // payment lane. Crypto-only is allowed when acceptsCrypto=true; in
    // every other case the organizer needs at least one fiat provider
    // enabled for the event's country (Paystack/Monnify subaccount on
    // OrganizerProfile). Per-provider enable lives in OrganizerController.
    const profile = event.organizer.organizerProfile;
    const hasPaystack = !!profile?.paystackSubaccountCode;
    const hasMonnify = !!profile?.monnifySubAccountCode;
    const hasFiat = hasPaystack || hasMonnify;

    if (!event.acceptsCrypto && !hasFiat) {
      throw new BadRequestException(
        'This event has no payment method available. Either enable a fiat ' +
          'provider via /api/organizer/providers/{paystack,monnify}/enable, ' +
          'or set acceptsCrypto=true on the event.',
      );
    }

    // Validate completeness
    if (
      !event.name ||
      !event.description ||
      !event.venue ||
      !event.location ||
      !event.category ||
      !event.startTime ||
      !event.endTime ||
      !event.purchaseStartTime
    ) {
      throw new BadRequestException('Event has incomplete required fields');
    }

    if (event.ticketTypes.length === 0) {
      throw new BadRequestException('Event must have at least one ticket type');
    }

    // Generate a per-event symbol prefix from the event name
    // (e.g., "Lagos Tech Summit 2026" -> "LTS26").
    const eventSymbol = event.name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6);

    // Each ticket type becomes its own on-chain entry — one createTicket
    // call per type. Build the per-type payloads + pre-create one
    // BlockchainTransaction row per type so the worker can attach the
    // Circle transactionId to the right row when it runs.
    // On-chain fees are denominated in USDC (6-dp), converted from the
    // event's NGN price. `computeUsdcFees` runs the ORGANIZER-BEARS model
    // (buyer pays face price; HostIT's cut is backed out of `ticketFee`) so
    // the buyer sees the same number on the fiat and crypto rails.
    const usdcNgnRate =
      this.configService.getOrThrow<number>('crypto.usdcNgnRate');

    const ticketTypePayloads = event.ticketTypes.map((tt) => ({
      ticketTypeId: tt.id,
      ticketData: {
        startTime: Math.floor(event.startTime.getTime() / 1000),
        endTime: Math.floor(event.endTime.getTime() / 1000),
        purchaseStartTime: Math.floor(event.purchaseStartTime.getTime() / 1000),
        maxTickets: tt.quantity,
        maxTicketsPerUser: tt.maxPerUser,
        isFree: event.isFree,
        isRefundable: event.isRefundable,
        name: `${event.name} — ${tt.name}`,
        symbol: `${eventSymbol}-${tt.name.replace(/\s+/g, '').slice(0, 4).toUpperCase()}`,
        uri: `https://api.hostit.ng/events/${event.slug}/${tt.id}/metadata`,
      },
      // Crypto checkout settles in USDC via `mintTicket`. Free events
      // ignore fees on-chain (createTicket skips setTicketFees when
      // isFree), so the converted value is harmless there.
      feeTypes: ['USDC'],
      prices: [computeUsdcFees(tt.price, usdcNgnRate).ticketFee],
    }));

    // Atomic transition + per-type BlockchainTransaction rows
    const updatedEvent = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.event.update({
        where: { id: eventId },
        data: { status: EventStatus.PUBLISHED },
        include: {
          ticketTypes: true,
          organizer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      });

      // Create one BlockchainTransaction row per ticket type, then
      // capture the IDs so we can attach them to job payloads below.
      // Loop is sequential (small N: usually 1-5 ticket types per event).
      for (const payload of ticketTypePayloads) {
        const btx = await tx.blockchainTransaction.create({
          data: {
            eventId,
            type: BlockchainTxType.CREATE_EVENT,
            status: BlockchainTxStatus.PENDING,
            chain: event.chain,
          },
        });
        // Stash the row id back onto the payload for the enqueue loop
        (payload as { blockchainTxId?: string }).blockchainTxId = btx.id;
      }

      return updated;
    });

    // Enqueue one job per ticket type — each one independent, retryable
    // on its own. Workers in BlockchainModule consume `event-publish`.
    for (const payload of ticketTypePayloads) {
      await this.eventPublishQueue.add('create-event', {
        eventId,
        chain: event.chain,
        ticketTypeId: payload.ticketTypeId,
        blockchainTxId: (payload as { blockchainTxId?: string }).blockchainTxId,
        ticketData: payload.ticketData,
        feeTypes: payload.feeTypes,
        prices: payload.prices,
      });
    }

    this.logger.log(
      `Event published: ${updatedEvent.name} (${updatedEvent.slug}) — ${ticketTypePayloads.length} on-chain entries queued on ${event.chain}`,
    );

    // Notify organizer their event is live. The on-chain mint is still
    // processing in the background, but from the organizer's POV the
    // event is published and shareable now — that's what this email
    // confirms. Fire-and-forget; queue outage doesn't undo the publish.
    try {
      const appUrl = this.configService.get<string>('notifications.appUrl', '');
      await this.notifications.enqueue({
        type: 'EVENT_PUBLISHED',
        to: updatedEvent.organizer.email,
        userId: updatedEvent.organizer.id,
        data: {
          organizerName: updatedEvent.organizer.firstName,
          eventName: updatedEvent.name,
          eventUrl: `${appUrl}/events/${updatedEvent.slug}`,
          dashboardUrl: `${appUrl}/organizer/events/${updatedEvent.id}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue event-published email for event ${eventId}: ${(err as Error).message}`,
      );
    }

    return {
      ...updatedEvent,
      message: 'Event is being published. On-chain registration is processing.',
    };
  }

  async cancel(eventId: string, organizerId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You can only cancel your own events');
    }

    if (event.status === EventStatus.CANCELLED) {
      throw new BadRequestException('Event is already cancelled');
    }

    if (event.status === EventStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed event');
    }

    // Check if any tickets have been sold
    const totalSold = event.ticketTypes.reduce(
      (sum, tt) => sum + tt.soldCount,
      0,
    );

    if (
      event.status === EventStatus.PUBLISHED &&
      totalSold > 0 &&
      !event.isRefundable
    ) {
      throw new BadRequestException(
        'Cannot cancel event with sold tickets that is not refundable',
      );
    }

    // Cancel the event
    const updatedEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: { status: EventStatus.CANCELLED },
    });

    // If DRAFT, clean up ticket types
    if (event.status === EventStatus.DRAFT) {
      await this.prisma.ticketType.deleteMany({
        where: { eventId },
      });
    }

    // TODO: If tickets sold and refundable, queue refund processing (Phase 4/5)
    if (totalSold > 0) {
      this.logger.warn(
        `Cancelled event ${eventId} has ${totalSold} sold tickets — refunds pending`,
      );
    }

    this.logger.log(`Event cancelled: ${event.name} (${event.slug})`);

    return {
      id: updatedEvent.id,
      name: updatedEvent.name,
      status: updatedEvent.status,
      message: 'Event has been cancelled.',
    };
  }

  async findBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug, status: EventStatus.PUBLISHED },
      include: {
        ticketTypes: true,
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const now = new Date();
    const ticketTypes = event.ticketTypes.map((tt) => {
      const available = tt.quantity - tt.soldCount;
      const withinSaleDates =
        (!tt.salesStartDate || tt.salesStartDate <= now) &&
        (!tt.salesEndDate || tt.salesEndDate >= now);
      const isOnSale = available > 0 && withinSaleDates;

      return {
        ...tt,
        available,
        isOnSale,
      };
    });

    return {
      ...event,
      ticketTypes,
    };
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const baseSlug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    // Check if slug already exists
    const existing = await this.prisma.event.findUnique({
      where: { slug: baseSlug },
    });

    if (!existing) {
      return baseSlug;
    }

    // Append random suffix on collision
    const suffix = crypto.randomBytes(4).toString('hex');
    return `${baseSlug}-${suffix}`;
  }
}
