import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CircleService } from './circle.service';
import { CircleHealthIndicator } from './circle.health';
import { CircleWebhookService } from './circle-webhook.service';

@Module({
  imports: [TerminusModule],
  providers: [CircleService, CircleHealthIndicator, CircleWebhookService],
  exports: [CircleService, CircleHealthIndicator, CircleWebhookService],
})
export class CircleModule {}
