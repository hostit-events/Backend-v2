import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CircleService } from './circle.service';
import { CircleHealthIndicator } from './circle.health';

@Module({
  imports: [TerminusModule],
  providers: [CircleService, CircleHealthIndicator],
  exports: [CircleService, CircleHealthIndicator],
})
export class CircleModule {}
