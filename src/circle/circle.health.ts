import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { CircleService } from './circle.service';

@Injectable()
export class CircleHealthIndicator extends HealthIndicator {
  constructor(
    private readonly circle: CircleService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // Skip the live API call in tests — CI and local `pnpm test:e2e`
    // run with dummy Circle credentials, and making a real call would
    // couple /health smoke tests to Circle's uptime.
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return this.getStatus(key, true, { skipped: true });
    }

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
