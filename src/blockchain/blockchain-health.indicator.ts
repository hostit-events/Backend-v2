import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { BlockchainReadService } from './blockchain-read.service';

/**
 * Pings every active chain's RPC and reports per-chain block heights
 * on /health. Skipped under NODE_ENV=test so e2e suites don't depend
 * on an outbound RPC connection — same pattern as CircleHealthIndicator.
 */
@Injectable()
export class BlockchainHealthIndicator extends HealthIndicator {
  constructor(
    private readonly read: BlockchainReadService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return this.getStatus(key, true, { skipped: true });
    }

    const heights: Record<string, number | string> = {};
    const failures: string[] = [];

    for (const chain of this.read.listChains()) {
      try {
        heights[chain.id] = await this.read.getBlockNumber(chain.id);
      } catch (err) {
        heights[chain.id] = `error: ${(err as Error).message}`;
        failures.push(chain.id);
      }
    }

    if (failures.length > 0) {
      throw new HealthCheckError(
        `Blockchain RPC unreachable for: ${failures.join(', ')}`,
        this.getStatus(key, false, heights),
      );
    }
    return this.getStatus(key, true, heights);
  }
}
