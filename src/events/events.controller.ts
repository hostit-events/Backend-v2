import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @ApiBearerAuth()
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new event with ticket types (DRAFT)' })
  create(@CurrentUser('id') organizerId: string, @Body() dto: CreateEventDto) {
    return this.eventsService.create(organizerId, dto);
  }
}
