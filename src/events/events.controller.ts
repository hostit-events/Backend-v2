import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Browse and search published events' })
  findAll(@Query() query: QueryEventsDto) {
    return this.eventsService.findAll(query);
  }

  @Post()
  @ApiBearerAuth()
  @Roles(UserRole.ORGANIZER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new event with ticket types (DRAFT)' })
  create(@CurrentUser('id') organizerId: string, @Body() dto: CreateEventDto) {
    return this.eventsService.create(organizerId, dto);
  }
}
