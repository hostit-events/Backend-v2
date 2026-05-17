import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsProcessor } from './notifications.processor';
import {
  NOTIFICATIONS_QUEUE,
  NotificationsService,
} from './notifications.service';
import { ConsoleEmailProvider } from './providers/console.provider';
import { EMAIL_PROVIDER } from './providers/email-provider.interface';
import { SendGridEmailProvider } from './providers/sendgrid.provider';

/**
 * Provider selection at boot:
 *   - SendGrid when an API key is configured AND NODE_ENV=production.
 *   - Console (logs to stdout) otherwise — keeps `pnpm dev` runnable
 *     without SendGrid credentials.
 *
 * To force real sends from a non-production env (e.g. staging), set
 * NODE_ENV=production for that deploy or simply provide
 * SENDGRID_API_KEY and remove this guard — the explicit gate exists
 * to prevent accidental real-email traffic during local development.
 */
@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
  ],
  providers: [
    NotificationsService,
    NotificationsProcessor,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('notifications.sendgrid.apiKey');
        const nodeEnv = config.get<string>('NODE_ENV');
        if (apiKey && nodeEnv === 'production') {
          return new SendGridEmailProvider(config);
        }
        return new ConsoleEmailProvider();
      },
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
