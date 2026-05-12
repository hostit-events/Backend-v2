import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email-provider.interface';

/**
 * Dev/test fallback that logs the email envelope to stdout instead of
 * hitting SendGrid. Selected when SENDGRID_API_KEY is unset or
 * NODE_ENV=development. The HTML body is logged at debug level and
 * truncated to keep terminal output usable; pipe to a file or bump
 * log level if you need to inspect the full body.
 */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `[dev] would send email to=${message.to} subject="${message.subject}" attachments=${message.attachments?.length ?? 0}`,
    );
    this.logger.debug(
      `[dev] body preview: ${message.html.replace(/\s+/g, ' ').slice(0, 400)}`,
    );
    return Promise.resolve();
  }
}
