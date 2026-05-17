import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, TemplateData } from './templates';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const SEND_NOTIFICATION_JOB = 'send';

export interface SendNotificationJobData<
  T extends NotificationType = NotificationType,
> {
  notificationId: string;
  type: T;
  to: string;
  data: TemplateData[T];
}

/**
 * Single entry point for queuing transactional emails.
 *
 * Flow per send:
 *   1. Create a `Notification` row with status=PENDING — gives us an
 *      audit trail keyed off user/ticket and a place for the worker
 *      to flip status to SENT/FAILED.
 *   2. Enqueue a BullMQ job referencing that row. The worker
 *      (NotificationsProcessor) picks it up, renders the template,
 *      and hands it to the active EmailProvider.
 *
 * Callers should not await delivery — `enqueue()` returns once the
 * job is queued. Provider failures retry via BullMQ; terminal
 * failures land in NotificationStatus.FAILED.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueue<T extends NotificationType>(input: {
    type: T;
    to: string;
    data: TemplateData[T];
    userId?: string;
    ticketId?: string;
  }): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        channel: NotificationChannel.EMAIL,
        type: input.type,
        status: NotificationStatus.PENDING,
        userId: input.userId,
        ticketId: input.ticketId,
        metadata: { to: input.to },
      },
    });

    const jobData: SendNotificationJobData<T> = {
      notificationId: notification.id,
      type: input.type,
      to: input.to,
      data: input.data,
    };

    await this.queue.add(SEND_NOTIFICATION_JOB, jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    });

    this.logger.log(
      `Queued ${input.type} email notification=${notification.id} to=${input.to}`,
    );
  }
}
