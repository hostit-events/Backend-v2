import {
  Controller,
  Get,
  NotFoundException,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from './payments.service';

/**
 * Buyer-facing payment endpoints. Frontend hits this before rendering
 * the checkout picker so it doesn't have to know which providers serve
 * which countries.
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('methods')
  @Public()
  @ApiOperation({
    summary:
      'List eligible payment methods for an event (fiat + crypto, country-aware)',
  })
  @ApiQuery({ name: 'eventId', required: true, type: String })
  async methods(@Query('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        country: true,
        currency: true,
        acceptsCrypto: true,
      },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return this.payments.listMethods(event);
  }
}
