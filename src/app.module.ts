import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import {
  appConfig,
  authConfig,
  databaseConfig,
  redisConfig,
  paystackConfig,
  monnifyConfig,
  blockradarConfig,
  blockchainConfig,
  envValidationSchema,
} from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        redisConfig,
        paystackConfig,
        monnifyConfig,
        blockradarConfig,
        blockchainConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    PrismaModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
