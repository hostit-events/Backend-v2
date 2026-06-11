import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { TicketsService } from './tickets.service';
import { PurchaseTicketDto } from './dto/purchase-ticket.dto';
import { QueryMyTicketsDto } from './dto/query-my-tickets.dto';

@ApiTags('Tickets')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post('purchase')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initialize a ticket purchase (guest or authenticated)',
  })
  purchase(
    @Body() dto: PurchaseTicketDto,
    @CurrentUser('id') buyerId: string | undefined,
  ) {
    return this.tickets.purchase(dto, { buyerId });
  }

  // Declared before `:reference` so the literal path isn't captured as
  // a reference param. JWT required (no @Public → global JwtAuthGuard).
  @Get('mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my tickets (authenticated buyer)' })
  findMine(
    @CurrentUser('id') buyerId: string,
    @Query() query: QueryMyTicketsDto,
  ) {
    return this.tickets.findMyTickets(buyerId, query);
  }

  @Get(':reference')
  @Public()
  @ApiOperation({ summary: 'Get ticket by reference (public)' })
  findByReference(@Param('reference') reference: string) {
    return this.tickets.findByReference(reference);
  }
}
