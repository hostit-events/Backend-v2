import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EnableMonnifyDto } from './dto/enable-monnify.dto';
import { EnablePaystackDto } from './dto/enable-paystack.dto';
import { QueryOrganizerEventsDto } from './dto/query-organizer-events.dto';
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
