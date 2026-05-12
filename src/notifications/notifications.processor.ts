import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATIONS_QUEUE,
  SEND_NOTIFICATION_JOB,
  SendNotificationJobData,
} from './notifications.service';
import { EMAIL_PROVIDER } from './providers/email-provider.interface';
import type { EmailProvider } from './providers/email-provider.interface';
import { renderTemplate } from './templates';

/**
 * Consumes `notifications` jobs. Renders the requested template,
 * dispatches via the active EmailProvider, and updates the
 * Notification row. BullMQ owns retries (config in NotificationsService).
 *
 * Idempotency: jobs are keyed off a unique Notification row id. If the
 * row is already SENT we skip — protects against duplicate job
 * delivery (e.g. worker crash between provider send and DB update).
 */
@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
  ) {
    super();
  }

  async process(job: Job<SendNotificationJobData>): Promise<void> {
    if (job.name !== SEND_NOTIFICATION_JOB) {
      this.logger.warn(`Unexpected job name on notifications: ${job.name}`);
      return;
    }

    const { notificationId, type, to, data } = job.data;

    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) {
      this.logger.warn(
        `Notification ${notificationId} not found — dropping job`,
      );
      return;
    }
    if (notification.status === NotificationStatus.SENT) {
      this.logger.log(
        `Notification ${notificationId} already SENT — skipping duplicate delivery`,
      );
      return;
    }

    const rendered = renderTemplate(type, data);

    try {
      await this.provider.send({
        to,
        subject: rendered.subject,
        html: rendered.html,
        attachments: rendered.attachments,
      });

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.SENT, sentAt: new Date() },
      });
      this.logger.log(`Sent ${type} notification=${notificationId} to=${to}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (isFinal) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: NotificationStatus.FAILED },
        });
        this.logger.error(
          `Notification ${notificationId} FAILED after ${job.attemptsMade + 1} attempts: ${message}`,
        );
      } else {
        this.logger.warn(
          `Notification ${notificationId} attempt ${job.attemptsMade + 1} failed: ${message}`,
        );
      }
      throw err;
    }
  }
}
