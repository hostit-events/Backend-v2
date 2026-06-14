import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { OrganizerService } from './organizer.service';

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
  constructor(private readonly organizer: OrganizerService) {}

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
