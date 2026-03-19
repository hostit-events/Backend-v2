import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
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
