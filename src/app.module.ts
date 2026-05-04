import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { PaymentsModule } from './payments/payments.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { CircleModule } from './circle/circle.module';
import { OrganizerModule } from './organizer/organizer.module';
import { WalletsModule } from './wallets/wallets.module';
import { TicketsModule } from './tickets/tickets.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import {
  appConfig,
  authConfig,
  databaseConfig,
  redisConfig,
  paystackConfig,
  monnifyConfig,
  blockradarConfig,
  blockchainConfig,
  circleConfig,
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
        circleConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host', 'localhost'),
          port: configService.get<number>('redis.port', 6379),
          password: configService.get<string>('redis.password') || undefined,
          // TLS is required for Upstash (and recommended for any
          // hosted Redis crossing the public internet). Local docker
          // Redis runs plaintext, so default to false. Set
          // REDIS_TLS=true in Render for the Upstash connection.
          tls:
            configService.get<string>('redis.tls') === 'true' ? {} : undefined,
          // BullMQ requirement: ioredis must retry forever, not give
          // up after N attempts. Without this, transient blips
          // (Upstash failover, Render network hiccups) crash workers
          // with MaxRetriesPerRequestError after ~3 minutes.
          maxRetriesPerRequest: null,
          // Skip the INFO command on connect — Upstash sometimes
          // returns NOAUTH for INFO before the AUTH handshake races
          // through, which BullMQ misinterprets as a fatal error.
          enableReadyCheck: false,
        },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 60 }],
    }),
    PrismaModule,
    CircleModule,
    WalletsModule,
    HealthModule,
    AuthModule,
    EventsModule,
    PaymentsModule,
    OrganizerModule,
    BlockchainModule,
    WebhooksModule,
    TicketsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
