import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import { EmailMessage, EmailProvider } from './email-provider.interface';

/**
 * Sends transactional email via the SendGrid v3 Mail Send API.
 *
 * Failures bubble up to the caller (NotificationsProcessor) which
 * relies on BullMQ's retry policy — we do NOT swallow errors here.
 * Permanent failures (invalid recipient, suspended account) will run
 * the retry budget and end up FAILED on the Notification row, which
 * is the correct outcome.
 */
@Injectable()
export class SendGridEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SendGridEmailProvider.name);
  private readonly fromEmail: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('notifications.sendgrid.apiKey');
    const fromEmail = config.get<string>('notifications.sendgrid.fromEmail');
    if (!apiKey || !fromEmail) {
      throw new Error(
        'SendGridEmailProvider: SENDGRID_API_KEY and SENDGRID_FROM_EMAIL are required',
      );
    }
    sgMail.setApiKey(apiKey);
    this.fromEmail = fromEmail;
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await sgMail.send({
        to: message.to,
        from: this.fromEmail,
        subject: message.subject,
        html: message.html,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          type: a.type,
          disposition: a.disposition,
          content_id: a.contentId,
        })),
      });
    } catch (err) {
      // SendGrid wraps API errors as ResponseError with a .response.body
      // we want in the logs. Re-throw so Bull retries.
      const e = err as { response?: { body?: unknown }; message?: string };
      this.logger.error(
        `SendGrid send failed: ${e.message ?? 'unknown'} body=${JSON.stringify(
          e.response?.body ?? null,
        )}`,
      );
      throw err;
    }
  }
}
