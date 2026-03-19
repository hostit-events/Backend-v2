import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';
import { EventStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
