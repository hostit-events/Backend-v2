import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainReadService } from '../blockchain/blockchain-read.service';
import {
  FEE_TYPE_USDC,
  SETTLEMENT_FEE_TYPE_NAME,
  USDC_DECIMALS,
} from '../blockchain/onchain-fees';

/** Format a 6-dp USDC base-unit amount as a decimal string. */
function formatUsdc(raw: bigint): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = s.slice(0, s.length - USDC_DECIMALS);
  const frac = s.slice(s.length - USDC_DECIMALS);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

type OnchainTicketType = {
  id: string;
  name: string;
  onChainTicketId: bigint;
};

/**
 * Organizer dashboard reads straight from the deployed Diamond — live
 * settlement balances and check-in counts. Pure view calls (no signing,
 * no gas). Per-ticket reads are resilient: one failing RPC call surfaces
 * as an `error` entry rather than failing the whole response.
 */
@Injectable()
export class OnchainReadsService {
  private readonly logger = new Logger(OnchainReadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly read: BlockchainReadService,
  ) {}

  /** Organizer's claimable/escrow USDC per ticket type. */
  async getBalances(organizerId: string, eventId: string) {
    const { chain, ticketTypes } = await this.loadOnchainTicketTypes(
      eventId,
      organizerId,
    );

    const tickets = await Promise.all(
      ticketTypes.map(async (t) => {
        try {
          const raw = await this.read.getTicketBalance(
            chain,
            t.onChainTicketId,
            FEE_TYPE_USDC,
          );
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            balanceUsdc: formatUsdc(raw),
            balanceRaw: raw.toString(),
          };
        } catch (err) {
          this.logger.warn(
            `getTicketBalance failed (event=${eventId}, ticketType=${t.id}): ${
              (err as Error).message
            }`,
          );
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            error: 'unavailable',
          };
        }
      }),
    );

    return { chain, feeType: SETTLEMENT_FEE_TYPE_NAME, tickets };
  }

  /** On-chain check-in totals per ticket type + event total. */
  async getCheckins(organizerId: string, eventId: string) {
    const { chain, ticketTypes } = await this.loadOnchainTicketTypes(
      eventId,
      organizerId,
    );

    const tickets = await Promise.all(
      ticketTypes.map(async (t) => {
        try {
          const addrs = await this.read.getCheckedIn(chain, t.onChainTicketId);
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            checkedIn: addrs.length,
          };
        } catch (err) {
          this.logger.warn(
            `getCheckedIn failed (event=${eventId}, ticketType=${t.id}): ${
              (err as Error).message
            }`,
          );
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            error: 'unavailable',
          };
        }
      }),
    );

    const total = tickets.reduce(
      (sum, t) => sum + (typeof t.checkedIn === 'number' ? t.checkedIn : 0),
      0,
    );
    return { chain, total, tickets };
  }

  /** Per-ticket-type check-in counts for a specific event day (0-based). */
  async getCheckinsForDay(organizerId: string, eventId: string, day: number) {
    if (!Number.isInteger(day) || day < 0 || day > 255) {
      throw new BadRequestException('day must be an integer between 0 and 255');
    }
    const { chain, ticketTypes } = await this.loadOnchainTicketTypes(
      eventId,
      organizerId,
    );

    const tickets = await Promise.all(
      ticketTypes.map(async (t) => {
        try {
          const addrs = await this.read.getCheckedInForDay(
            chain,
            t.onChainTicketId,
            day,
          );
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            checkedIn: addrs.length,
          };
        } catch (err) {
          this.logger.warn(
            `getCheckedInForDay failed (event=${eventId}, ticketType=${t.id}, day=${day}): ${
              (err as Error).message
            }`,
          );
          return {
            ticketTypeId: t.id,
            name: t.name,
            onChainTicketId: t.onChainTicketId.toString(),
            error: 'unavailable',
          };
        }
      }),
    );

    const total = tickets.reduce(
      (sum, t) => sum + (typeof t.checkedIn === 'number' ? t.checkedIn : 0),
      0,
    );
    return { chain, day, total, tickets };
  }

  // ---------- internals ----------

  private async loadOnchainTicketTypes(
    eventId: string,
    organizerId: string,
  ): Promise<{ chain: string; ticketTypes: OnchainTicketType[] }> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        organizerId: true,
        chain: true,
        ticketTypes: {
          select: { id: true, name: true, onChainTicketId: true },
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

    const ticketTypes = event.ticketTypes
      .filter((t): t is OnchainTicketType => t.onChainTicketId !== null)
      .map((t) => ({
        id: t.id,
        name: t.name,
        onChainTicketId: t.onChainTicketId,
      }));

    return { chain: event.chain, ticketTypes };
  }
}
