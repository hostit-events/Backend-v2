import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { EnableMonnifyDto } from './dto/enable-monnify.dto';
import { EnablePaystackDto } from './dto/enable-paystack.dto';
import { QueryOrganizerEventsDto } from './dto/query-organizer-events.dto';
import { QueryAttendeesDto } from './dto/query-attendees.dto';
import { QueryPayoutsDto } from './dto/query-payouts.dto';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { TicketAdminsDto } from './dto/ticket-admins.dto';
import { UpdateTicketFeeDto } from './dto/update-ticket-fee.dto';
import { OrganizerService } from './organizer.service';
import { PayoutsService } from './payouts.service';
import { TicketAdminsService } from './ticket-admins.service';
import { TicketFeesService } from './ticket-fees.service';
import { OnchainReadsService } from './onchain-reads.service';

/**
 * Per-provider fiat enablement endpoints.
 *
 * Caller must already be an ORGANIZER (via /auth/become-organizer).
 * Each enable call performs the relevant KYC + bank verification +
 * provider subaccount creation, then writes the result onto the
 * caller's OrganizerProfile.
 */
@ApiTags('Organizer')
@ApiBearerAuth()
@Controller('organizer')
export class OrganizerController {
  constructor(
    private readonly organizer: OrganizerService,
    private readonly payouts: PayoutsService,
    private readonly ticketAdmins: TicketAdminsService,
    private readonly ticketFees: TicketFeesService,
    private readonly onchainReads: OnchainReadsService,
  ) {}

  @Get('events')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({
    summary: 'My events with sales stats (organizer dashboard landing)',
  })
  getMyEvents(
    @CurrentUser('id') userId: string,
    @Query() query: QueryOrganizerEventsDto,
  ) {
    return this.organizer.getMyEvents(userId, query);
  }

  @Get('events/:id/analytics')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Event analytics (daily sales, breakdowns, check-in rate)',
  })
  getEventAnalytics(
    @Param('id') id: string,
    @CurrentUser() actor: { id: string; role: UserRole },
  ) {
    return this.organizer.getEventAnalytics(id, actor);
  }

  @Get('events/:id/attendees')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Attendee list for an event (filterable)' })
  getAttendees(
    @Param('id') id: string,
    @Query() query: QueryAttendeesDto,
    @CurrentUser() actor: { id: string; role: UserRole },
  ) {
    return this.organizer.getAttendees(id, query, actor);
  }

  @Get('events/:id/attendees/export')
  @Roles(UserRole.ORGANIZER, UserRole.ADMIN)
  @SkipTransform()
  @ApiOperation({ summary: 'Export attendees as a CSV download' })
  async exportAttendees(
    @Param('id') id: string,
    @CurrentUser() actor: { id: string; role: UserRole },
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, csv } = await this.organizer.exportAttendeesCSV(
      id,
      actor,
    );
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return csv;
  }

  @Put('bank-details')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update settlement bank details (Paystack-verified)',
  })
  updateBankDetails(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateBankDetailsDto,
  ) {
    return this.organizer.updateBankDetails(userId, dto);
  }

  @Get('events/:id/ticket-admins')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({ summary: 'List active check-in delegates (ticket admins)' })
  listTicketAdmins(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.ticketAdmins.listAdmins(userId, id);
  }

  @Post('events/:id/ticket-admins')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Delegate check-in: grant ticket-admin to users',
  })
  addTicketAdmins(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: TicketAdminsDto,
  ) {
    return this.ticketAdmins.addAdmins(userId, id, dto.userIds);
  }

  @Delete('events/:id/ticket-admins')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke ticket-admin (check-in) from users' })
  removeTicketAdmins(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: TicketAdminsDto,
  ) {
    return this.ticketAdmins.removeAdmins(userId, id, dto.userIds);
  }

  @Patch('events/:id/tickets/:ticketTypeId/fee')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a ticket price (on-chain fee) after publish',
  })
  updateTicketFee(
    @Param('id') id: string,
    @Param('ticketTypeId') ticketTypeId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateTicketFeeDto,
  ) {
    return this.ticketFees.updateFee(userId, id, ticketTypeId, dto.priceNgn);
  }

  @Get('events/:id/onchain/balance')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({
    summary: 'On-chain claimable/escrow USDC balance per ticket type',
  })
  getOnchainBalance(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.onchainReads.getBalances(userId, id);
  }

  @Get('events/:id/onchain/checkins')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({ summary: 'On-chain check-in totals per ticket type' })
  getOnchainCheckins(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.onchainReads.getCheckins(userId, id);
  }

  @Get('events/:id/onchain/checkins/day/:day')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({
    summary: 'On-chain check-in counts for a specific event day (0-based)',
  })
  getOnchainCheckinsForDay(
    @Param('id') id: string,
    @Param('day', ParseIntPipe) day: number,
    @CurrentUser('id') userId: string,
  ) {
    return this.onchainReads.getCheckinsForDay(userId, id, day);
  }

  @Post('payouts/request')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request an event payout (withdraw on-chain USDC escrow)',
  })
  requestPayout(
    @CurrentUser('id') userId: string,
    @Body() dto: RequestPayoutDto,
  ) {
    return this.payouts.requestPayout(userId, dto.eventId);
  }

  @Get('payouts')
  @Roles(UserRole.ORGANIZER)
  @ApiOperation({ summary: 'Payout history with summary (filter, paginate)' })
  getPayouts(
    @CurrentUser('id') userId: string,
    @Query() query: QueryPayoutsDto,
  ) {
    return this.payouts.getPayoutHistory(userId, query);
  }

  @Post('providers/paystack/enable')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable Paystack fiat checkout (BVN + bank → subaccount)',
  })
  enablePaystack(
    @Body() dto: EnablePaystackDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.organizer.enablePaystack(userId, dto);
  }

  @Post('providers/monnify/enable')
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable Monnify fiat checkout (BVN + bank → sub-account)',
  })
  enableMonnify(
    @Body() dto: EnableMonnifyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.organizer.enableMonnify(userId, dto);
  }
}
