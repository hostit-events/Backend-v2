import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventStatus,
  Prisma,
  TicketStatus,
  TransactionStatus,
  UserRole,
} from '@prisma/client';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { PaystackService } from '../paystack/paystack.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnableMonnifyDto } from './dto/enable-monnify.dto';
import { EnablePaystackDto } from './dto/enable-paystack.dto';
import { QueryOrganizerEventsDto } from './dto/query-organizer-events.dto';
import { QueryAttendeesDto } from './dto/query-attendees.dto';

/** Ticket statuses that count as a completed sale. */
const SOLD_STATUSES: TicketStatus[] = [
  TicketStatus.CONFIRMED,
  TicketStatus.USED,
];

/** UTC YYYY-MM-DD key for a timestamp. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** RFC-4180 CSV field escaping. */
function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Inclusive list of UTC day keys from `from` to `to`. */
function eachDay(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Per-provider fiat enablement for organizers.
 *
 * Onboarding shifted from "BVN+bank+subaccounts at /become-organizer"
 * to "no KYC at signup; KYC and subaccount creation happen here, per
 * provider, when the organizer wants to accept fiat for an event."
 *
 * Each enable endpoint takes the provider-specific KYC + bank fields,
 * verifies them, creates the provider-side subaccount, and writes the
 * relevant columns onto OrganizerProfile. Once any fiat provider is
 * enabled for a country, events in that country can list that
 * provider as a checkout option.
 */
@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly paystack: PaystackService,
    private readonly monnify: MonnifyProvider,
  ) {}

  /**
   * Organizer dashboard landing: the caller's events with per-event and
   * per-ticket-type sales stats, plus a top-level summary computed across
   * ALL their events (not just the current page).
   *
   * Stats are derived with grouped aggregations (groupBy + _count) rather
   * than loading ticket rows. "Sold" = CONFIRMED or USED; "checkedIn" =
   * USED. Revenue is sold count x current ticket-type price.
   */
  async getMyEvents(userId: string, query: QueryOrganizerEventsDto) {
    // ---- summary across ALL the organizer's events ----
    const [totalEvents, publishedEvents, soldGroupsAll, typePrices] =
      await Promise.all([
        this.prisma.event.count({ where: { organizerId: userId } }),
        this.prisma.event.count({
          where: { organizerId: userId, status: EventStatus.PUBLISHED },
        }),
        this.prisma.ticket.groupBy({
          by: ['ticketTypeId'],
          where: {
            event: { organizerId: userId },
            status: { in: SOLD_STATUSES },
          },
          _count: { _all: true },
        }),
        this.prisma.ticketType.findMany({
          where: { event: { organizerId: userId } },
          select: { id: true, price: true },
        }),
      ]);

    const priceById = new Map(
      typePrices.map((t) => [t.id, Number(t.price)] as const),
    );
    let totalTicketsSold = 0;
    let totalRevenue = 0;
    for (const g of soldGroupsAll) {
      const sold = g._count._all;
      totalTicketsSold += sold;
      totalRevenue += sold * (priceById.get(g.ticketTypeId) ?? 0);
    }

    // ---- paginated events list (status-filtered) ----
    const where: Prisma.EventWhereInput = { organizerId: userId };
    if (query.status) {
      where.status = query.status;
    }

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          name: true,
          slug: true,
          coverImage: true,
          startTime: true,
          endTime: true,
          status: true,
          category: true,
          createdAt: true,
          ticketTypes: {
            select: { id: true, name: true, price: true, quantity: true },
          },
        },
      }),
      this.prisma.event.count({ where }),
    ]);

    // One grouped read for every ticket on the page, split by type + status.
    const pageEventIds = events.map((e) => e.id);
    const ticketGroups = pageEventIds.length
      ? await this.prisma.ticket.groupBy({
          by: ['ticketTypeId', 'status'],
          where: { eventId: { in: pageEventIds } },
          _count: { _all: true },
        })
      : [];

    const statsByType = new Map<string, { sold: number; checkedIn: number }>();
    for (const g of ticketGroups) {
      const entry = statsByType.get(g.ticketTypeId) ?? {
        sold: 0,
        checkedIn: 0,
      };
      if (SOLD_STATUSES.includes(g.status)) {
        entry.sold += g._count._all;
      }
      if (g.status === TicketStatus.USED) {
        entry.checkedIn += g._count._all;
      }
      statsByType.set(g.ticketTypeId, entry);
    }

    const eventsWithStats = events.map((event) => {
      let totalTickets = 0;
      let ticketsSold = 0;
      let revenue = 0;
      let checkedIn = 0;
      const ticketTypes = event.ticketTypes.map((tt) => {
        const s = statsByType.get(tt.id) ?? { sold: 0, checkedIn: 0 };
        const typeRevenue = s.sold * Number(tt.price);
        totalTickets += tt.quantity;
        ticketsSold += s.sold;
        revenue += typeRevenue;
        checkedIn += s.checkedIn;
        return {
          name: tt.name,
          sold: s.sold,
          total: tt.quantity,
          revenue: typeRevenue,
        };
      });

      const { ticketTypes: _types, ...rest } = event;
      return {
        ...rest,
        stats: {
          totalTickets,
          ticketsSold,
          ticketsAvailable: totalTickets - ticketsSold,
          totalRevenue: revenue,
          checkedIn,
          ticketTypes,
        },
      };
    });

    return {
      summary: { totalEvents, publishedEvents, totalRevenue, totalTicketsSold },
      events: eventsWithStats,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * Single-event analytics for the owning organizer (or an admin):
   * overview KPIs, daily sales (gap-filled for chart continuity), and
   * breakdowns by ticket type, payment provider, and payment channel.
   *
   * Revenue / provider / channel come from SUCCESS transactions (one row
   * per purchase, with `channel` persisted into metadata on settlement);
   * sold/check-in counts come from the ticket table.
   */
  async getEventAnalytics(
    eventId: string,
    actor: { id: string; role: UserRole },
  ) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        status: true,
        startTime: true,
        organizerId: true,
        ticketTypes: {
          select: { id: true, name: true, price: true, quantity: true },
        },
      },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id) {
      throw new ForbiddenException('You do not have access to this event');
    }

    const [txns, ticketGroups] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { eventId, status: TransactionStatus.SUCCESS },
        select: {
          amount: true,
          provider: true,
          quantity: true,
          createdAt: true,
          metadata: true,
        },
      }),
      this.prisma.ticket.groupBy({
        by: ['ticketTypeId', 'status'],
        where: { eventId },
        _count: { _all: true },
      }),
    ]);

    // --- revenue / provider / channel / daily, from transactions ---
    let totalRevenue = 0;
    const provMap = new Map<string, { amount: number; count: number }>();
    const chanMap = new Map<string, { amount: number; count: number }>();
    const byDay = new Map<string, { ticketsSold: number; revenue: number }>();

    for (const t of txns) {
      const amount = Number(t.amount);
      totalRevenue += amount;

      const prov = provMap.get(t.provider) ?? { amount: 0, count: 0 };
      prov.amount += amount;
      prov.count += t.quantity;
      provMap.set(t.provider, prov);

      const channel =
        ((t.metadata as Record<string, unknown> | null)?.channel as
          | string
          | undefined) ?? 'unknown';
      const chan = chanMap.get(channel) ?? { amount: 0, count: 0 };
      chan.amount += amount;
      chan.count += t.quantity;
      chanMap.set(channel, chan);

      const day = dayKey(t.createdAt);
      const d = byDay.get(day) ?? { ticketsSold: 0, revenue: 0 };
      d.ticketsSold += t.quantity;
      d.revenue += amount;
      byDay.set(day, d);
    }

    const revenueByProvider = [...provMap.entries()].map(([provider, v]) => ({
      provider,
      amount: v.amount,
      count: v.count,
    }));
    const revenueByChannel = [...chanMap.entries()].map(([channel, v]) => ({
      channel,
      amount: v.amount,
      count: v.count,
    }));

    // Gap-filled daily series: first sale day → today, zeros for empty days.
    const dailySales: { date: string; ticketsSold: number; revenue: number }[] =
      [];
    if (byDay.size > 0) {
      const first = new Date(`${[...byDay.keys()].sort()[0]}T00:00:00Z`);
      for (const day of eachDay(first, new Date())) {
        const d = byDay.get(day) ?? { ticketsSold: 0, revenue: 0 };
        dailySales.push({ date: day, ...d });
      }
    }

    // --- ticket-type breakdown + sold/check-in, from tickets ---
    const statsByType = new Map<string, { sold: number; checkedIn: number }>();
    for (const g of ticketGroups) {
      const e = statsByType.get(g.ticketTypeId) ?? { sold: 0, checkedIn: 0 };
      if (SOLD_STATUSES.includes(g.status)) {
        e.sold += g._count._all;
      }
      if (g.status === TicketStatus.USED) {
        e.checkedIn += g._count._all;
      }
      statsByType.set(g.ticketTypeId, e);
    }

    let totalTicketsSold = 0;
    let totalCheckedIn = 0;
    let totalCapacity = 0;
    const ticketTypeBreakdown = event.ticketTypes.map((tt) => {
      const s = statsByType.get(tt.id) ?? { sold: 0, checkedIn: 0 };
      const price = Number(tt.price);
      totalTicketsSold += s.sold;
      totalCheckedIn += s.checkedIn;
      totalCapacity += tt.quantity;
      return {
        name: tt.name,
        price,
        sold: s.sold,
        total: tt.quantity,
        revenue: s.sold * price,
        percentSold: tt.quantity ? Math.round((s.sold / tt.quantity) * 100) : 0,
      };
    });

    return {
      event: {
        id: event.id,
        name: event.name,
        status: event.status,
        startTime: event.startTime,
      },
      overview: {
        totalRevenue,
        totalTicketsSold,
        totalTicketsAvailable: totalCapacity - totalTicketsSold,
        totalCheckedIn,
        checkInRate: totalTicketsSold
          ? Math.round((totalCheckedIn / totalTicketsSold) * 100)
          : 0,
        averageTicketPrice: totalTicketsSold
          ? Math.round(totalRevenue / totalTicketsSold)
          : 0,
      },
      dailySales,
      ticketTypeBreakdown,
      revenueByProvider,
      revenueByChannel,
    };
  }

  /**
   * Paginated attendee roster for an event (owner/admin), with optional
   * status / ticket-type / name-or-email-search filters. The summary
   * counts are event-wide (independent of the list filters).
   */
  async getAttendees(
    eventId: string,
    query: QueryAttendeesDto,
    actor: { id: string; role: UserRole },
  ) {
    await this.assertEventAccess(eventId, actor);

    const where: Prisma.TicketWhereInput = { eventId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.ticketTypeId) {
      where.ticketTypeId = query.ticketTypeId;
    }
    if (query.search) {
      where.OR = [
        { buyerName: { contains: query.search, mode: 'insensitive' } },
        { buyerEmail: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total, statusGroups] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          reference: true,
          buyerName: true,
          buyerEmail: true,
          buyerPhone: true,
          status: true,
          checkedInAt: true,
          createdAt: true,
          ticketType: { select: { name: true } },
        },
      }),
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.groupBy({
        by: ['status'],
        where: { eventId },
        _count: { _all: true },
      }),
    ]);

    const countByStatus = new Map(
      statusGroups.map((g) => [g.status, g._count._all] as const),
    );
    const totalAttendees = [...countByStatus.values()].reduce(
      (a, b) => a + b,
      0,
    );

    return {
      attendees: rows.map((r) => ({
        ticketReference: r.reference,
        buyerName: r.buyerName,
        buyerEmail: r.buyerEmail,
        buyerPhone: r.buyerPhone,
        ticketType: r.ticketType.name,
        status: r.status,
        checkedInAt: r.checkedInAt,
        purchasedAt: r.createdAt,
      })),
      summary: {
        totalAttendees,
        confirmed: countByStatus.get(TicketStatus.CONFIRMED) ?? 0,
        checkedIn: countByStatus.get(TicketStatus.USED) ?? 0,
        cancelled: countByStatus.get(TicketStatus.CANCELLED) ?? 0,
      },
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * Full (unpaginated) attendee export as a CSV string, plus a slug-based
   * filename. Owner/admin only.
   */
  async exportAttendeesCSV(
    eventId: string,
    actor: { id: string; role: UserRole },
  ): Promise<{ filename: string; csv: string }> {
    const event = await this.assertEventAccess(eventId, actor);

    const rows = await this.prisma.ticket.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      select: {
        reference: true,
        buyerName: true,
        buyerEmail: true,
        buyerPhone: true,
        status: true,
        checkedInAt: true,
        createdAt: true,
        ticketType: { select: { name: true } },
      },
    });

    const header = [
      'Reference',
      'Name',
      'Email',
      'Phone',
      'Ticket Type',
      'Status',
      'Checked In',
      'Purchased At',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.reference,
          r.buyerName,
          r.buyerEmail,
          r.buyerPhone ?? '',
          r.ticketType.name,
          r.status,
          r.checkedInAt ? r.checkedInAt.toISOString() : '',
          r.createdAt.toISOString(),
        ]
          .map(csvEscape)
          .join(','),
      );
    }

    return { filename: `${event.slug}-attendees.csv`, csv: lines.join('\n') };
  }

  /** Load an event and assert the caller owns it (or is an admin). */
  private async assertEventAccess(
    eventId: string,
    actor: { id: string; role: UserRole },
  ): Promise<{ id: string; slug: string }> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, slug: true, organizerId: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (actor.role !== UserRole.ADMIN && event.organizerId !== actor.id) {
      throw new ForbiddenException('You do not have access to this event');
    }
    return { id: event.id, slug: event.slug };
  }

  async enablePaystack(userId: string, dto: EnablePaystackDto) {
    const { profile, user } = await this.loadOrganizer(userId);

    if (profile.paystackSubaccountCode) {
      throw new ConflictException(
        'Paystack is already enabled for this organizer',
      );
    }

    const bvnData = await this.verifyBvn(userId, dto.bvn);
    const bankData = await this.verifyBankAccount(
      user,
      dto.accountNumber,
      dto.bankCode,
    );

    let subaccount: { subaccountCode: string; id: number | null };
    if (this.shouldMockProviderSubaccount()) {
      subaccount = { subaccountCode: `DEV_PAYSTACK_${userId}`, id: null };
      this.logger.warn(
        `[DEV] Mocking Paystack subaccount for user ${userId} (SKIP_BANK_VERIFICATION=true) — no real subaccount created`,
      );
    } else {
      subaccount = await this.paystack
        .createSubaccount({
          businessName: bankData.accountName,
          bankCode: dto.bankCode,
          accountNumber: bankData.accountNumber,
        })
        .catch((err: Error) => {
          this.logger.warn(
            `Paystack subaccount creation failed for user ${userId}: ${err.message}`,
          );
          throw new BadRequestException(
            'Could not create Paystack subaccount. Please verify the bank details and try again.',
          );
        });
    }

    await this.prisma.organizerProfile.update({
      where: { id: profile.id },
      data: {
        bvn: dto.bvn,
        bvnVerified: true,
        bankCode: dto.bankCode,
        accountNumber: bankData.accountNumber,
        accountName: bankData.accountName,
        bankName: bvnData.firstName, // best-effort — replaced by a real bank-name lookup later
        bankVerified: true,
        kycTier: 'BASIC',
        kycStatus: 'VERIFIED',
        paystackSubaccountCode: subaccount.subaccountCode,
        paystackSubaccountId:
          subaccount.id != null ? String(subaccount.id) : null,
      },
    });

    this.logger.log(`Paystack enabled for user ${userId}`);
    return {
      message:
        'Paystack is now enabled. NGN events can use Paystack at checkout.',
      provider: 'PAYSTACK',
    };
  }

  async enableMonnify(userId: string, dto: EnableMonnifyDto) {
    const { profile, user } = await this.loadOrganizer(userId);

    if (profile.monnifySubAccountCode) {
      throw new ConflictException(
        'Monnify is already enabled for this organizer',
      );
    }

    // BVN/bank verification only runs when not already done by another
    // provider's enable. If Paystack already verified, reuse those
    // fields; otherwise verify now and persist.
    let bvn = profile.bvn ?? dto.bvn;
    let bankCode = profile.bankCode ?? dto.bankCode;
    let accountNumber = profile.accountNumber ?? dto.accountNumber;
    let accountName = profile.accountName;

    if (!profile.bvnVerified) {
      const bvnData = await this.verifyBvn(userId, dto.bvn);
      bvn = dto.bvn;
      // bvnData provides the legal name — first/last from NIBSS
      accountName ??= `${bvnData.firstName} ${bvnData.lastName}`.toUpperCase();
    }
    if (!profile.bankVerified) {
      const bankData = await this.verifyBankAccount(
        user,
        dto.accountNumber,
        dto.bankCode,
      );
      bankCode = dto.bankCode;
      accountNumber = bankData.accountNumber;
      accountName = bankData.accountName;
    }

    let subAccount: { subAccountCode: string; accountName: string };
    if (this.shouldMockProviderSubaccount()) {
      subAccount = {
        subAccountCode: `DEV_MONNIFY_${userId}`,
        accountName: accountName ?? `${user.firstName} ${user.lastName}`,
      };
      accountName ??= subAccount.accountName;
      this.logger.warn(
        `[DEV] Mocking Monnify sub-account for user ${userId} (SKIP_BANK_VERIFICATION=true) — no real sub-account created`,
      );
    } else {
      subAccount = await this.monnify
        .createSubAccount({
          bankCode,
          accountNumber,
          email: user.email,
        })
        .catch((err: Error) => {
          this.logger.warn(
            `Monnify sub-account creation failed for user ${userId}: ${err.message}`,
          );
          throw new BadRequestException(
            'Could not create Monnify sub-account. Please verify the bank details and try again.',
          );
        });
    }

    await this.prisma.organizerProfile.update({
      where: { id: profile.id },
      data: {
        bvn,
        bvnVerified: true,
        bankCode,
        accountNumber,
        accountName,
        bankVerified: true,
        kycTier: profile.kycTier === 'NONE' ? 'BASIC' : profile.kycTier,
        kycStatus: 'VERIFIED',
        monnifySubAccountCode: subAccount.subAccountCode,
      },
    });

    this.logger.log(`Monnify enabled for user ${userId}`);
    return {
      message:
        'Monnify is now enabled. NGN events can use Monnify at checkout.',
      provider: 'MONNIFY',
    };
  }

  // ---------- internals ----------

  /**
   * DEV ONLY. When SKIP_BANK_VERIFICATION is on (and we're not in
   * production), short-circuit provider subaccount creation and return
   * a deterministic fake code. This lets the enable flow complete
   * end-to-end without valid Paystack/Monnify sandbox bank data, which
   * their name-enquiry rejects for arbitrary test accounts.
   *
   * Safe by construction: the NODE_ENV guard means this can never
   * trigger in production, even if SKIP_BANK_VERIFICATION leaks into a
   * prod env. main.ts additionally refuses to boot in that case.
   */
  private shouldMockProviderSubaccount(): boolean {
    return (
      this.configService.get<string>('SKIP_BANK_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production'
    );
  }

  private async loadOrganizer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organizerProfile: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== UserRole.ORGANIZER) {
      throw new ForbiddenException(
        'You must call /become-organizer before enabling fiat providers',
      );
    }
    if (!user.organizerProfile) {
      // Defensive — becomeOrganizer always creates the row, but if a
      // legacy account is missing one we surface clearly.
      throw new NotFoundException(
        'Organizer profile missing — re-run /become-organizer',
      );
    }
    return { user, profile: user.organizerProfile };
  }

  /**
   * BVN check — Paystack's NIBSS passthrough. Skipped via
   * SKIP_BVN_VERIFICATION=true in dev (Paystack test accounts rarely
   * have NIBSS provisioned).
   */
  private async verifyBvn(
    userId: string,
    bvn: string,
  ): Promise<{ bvn: string; firstName: string; lastName: string }> {
    const skip =
      this.configService.get<string>('SKIP_BVN_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    if (skip) {
      this.logger.warn(
        `[DEV] Skipping BVN verification for user ${userId} (SKIP_BVN_VERIFICATION=true)`,
      );
      return { bvn, firstName: 'Dev', lastName: 'Bypass' };
    }

    try {
      return await this.paystack.resolveBvn(bvn);
    } catch {
      throw new BadRequestException('BVN verification failed');
    }
  }

  /**
   * Bank-account name resolution via Paystack. Same dev skip story.
   * Falls back to the user's name when skipped.
   */
  private async verifyBankAccount(
    user: { firstName: string; lastName: string },
    accountNumber: string,
    bankCode: string,
  ): Promise<{ accountNumber: string; accountName: string }> {
    const skip =
      this.configService.get<string>('SKIP_BANK_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    if (skip) {
      this.logger.warn(
        `[DEV] Skipping bank verification (SKIP_BANK_VERIFICATION=true)`,
      );
      return {
        accountNumber,
        accountName: `${user.firstName} ${user.lastName}`.toUpperCase(),
      };
    }

    try {
      return await this.paystack.resolveBankAccount(accountNumber, bankCode);
    } catch {
      throw new BadRequestException('Bank account verification failed');
    }
  }
}
