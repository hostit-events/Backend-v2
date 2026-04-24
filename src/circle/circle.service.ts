import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';

@Injectable()
export class CircleService implements OnModuleInit {
  private readonly logger = new Logger(CircleService.name);
  private _client!: CircleDeveloperControlledWalletsClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const apiKey = this.config.getOrThrow<string>('circle.apiKey');
    const entitySecret = this.config.getOrThrow<string>('circle.entitySecret');

    this._client = initiateDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    });

    const env = this.config.get<string>('circle.environment');
    const chain = this.config.get<string>('circle.defaultChain');
    this.logger.log(
      `Circle client initialized (env=${env}, defaultChain=${chain})`,
    );
  }

  get client(): CircleDeveloperControlledWalletsClient {
    return this._client;
  }

  get walletSetId(): string {
    return this.config.getOrThrow<string>('circle.walletSetId');
  }

  get treasuryWalletSetId(): string {
    return this.config.getOrThrow<string>('circle.treasuryWalletSetId');
  }

  get treasuryWalletId(): string {
    return this.config.getOrThrow<string>('circle.treasuryWalletId');
  }

  get defaultChain(): string {
    return this.config.getOrThrow<string>('circle.defaultChain');
  }
}
