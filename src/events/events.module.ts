import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'event-publish',
    }),
    NotificationsModule,
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
