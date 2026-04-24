import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CircleModule } from '../circle/circle.module';
import { USER_WALLET_QUEUE } from './wallets.constants';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { UserWalletProcessor } from './user-wallet.processor';

@Module({
  imports: [
    CircleModule,
    BullModule.registerQueue({ name: USER_WALLET_QUEUE }),
  ],
  controllers: [WalletsController],
  providers: [WalletsService, UserWalletProcessor],
  exports: [WalletsService],
})
export class WalletsModule {}
