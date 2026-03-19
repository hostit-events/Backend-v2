import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
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

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('event-publish') private readonly eventPublishQueue: Queue,
  ) {}

  async create(organizerId: string, dto: CreateEventDto) {
    // Verify organizer has KYC VERIFIED status
    const profile = await this.prisma.organizerProfile.findUnique({
      where: { userId: organizerId },
    });

    if (!profile || profile.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException(
        'Only verified organizers can create events',
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
      include: { ticketTypes: true },
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

    // Generate symbol from name (e.g., "Lagos Tech Summit 2026" -> "LTS26")
    const symbol = event.name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6);

    // Calculate aggregate values for smart contract
    const maxTickets = event.ticketTypes.reduce(
      (sum, tt) => sum + tt.quantity,
      0,
    );
    const maxTicketsPerUser = Math.max(
      ...event.ticketTypes.map((tt) => tt.maxPerUser),
    );

    // Update status and create blockchain transaction
    const [updatedEvent, blockchainTx] = await this.prisma.$transaction([
      this.prisma.event.update({
        where: { id: eventId },
        data: { status: EventStatus.PUBLISHED },
        include: {
          ticketTypes: true,
          organizer: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.blockchainTransaction.create({
        data: {
          eventId,
          type: BlockchainTxType.CREATE_EVENT,
          status: BlockchainTxStatus.PENDING,
        },
      }),
    ]);

    // Queue on-chain creation (processor built in Phase 6)
    await this.eventPublishQueue.add('create-event', {
      eventId,
      blockchainTxId: blockchainTx.id,
      ticketData: {
        startTime: Math.floor(event.startTime.getTime() / 1000),
        endTime: Math.floor(event.endTime.getTime() / 1000),
        purchaseStartTime: Math.floor(event.purchaseStartTime.getTime() / 1000),
        maxTickets,
        maxTicketsPerUser,
        isFree: event.isFree,
        isRefundable: event.isRefundable,
        name: event.name,
        symbol,
        uri: `https://api.hostit.ng/events/${event.slug}/metadata`,
      },
      feeTypes: event.ticketTypes.map(() => 'ETH'),
      prices: event.ticketTypes.map((tt) => tt.price.toString()),
    });

    this.logger.log(
      `Event published: ${updatedEvent.name} (${updatedEvent.slug})`,
    );

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
