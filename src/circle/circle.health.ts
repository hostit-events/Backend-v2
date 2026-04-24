import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { CircleService } from './circle.service';

@Injectable()
export class CircleHealthIndicator extends HealthIndicator {
  constructor(private readonly circle: CircleService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const walletSetId = this.circle.walletSetId;
      await this.circle.client.getWalletSet({ id: walletSetId });
      return this.getStatus(key, true, { walletSetId });
    } catch (error) {
      throw new HealthCheckError(
        'Circle check failed',
        this.getStatus(key, false, { message: (error as Error).message }),
      );
    }
  }
}
