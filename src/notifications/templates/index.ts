import { eventPublishedTemplate } from './event-published.template';
import { passwordResetTemplate } from './password-reset.template';
import { payoutCompletedTemplate } from './payout-completed.template';
import { ticketConfirmationTemplate } from './ticket-confirmation.template';
import { NotificationType, RenderedEmail, TemplateData } from './types';
import { welcomeTemplate } from './welcome.template';

export type { NotificationType, RenderedEmail, TemplateData } from './types';

export function renderTemplate<T extends NotificationType>(
  type: T,
  data: TemplateData[T],
): RenderedEmail {
  switch (type) {
    case 'WELCOME':
      return welcomeTemplate(data as TemplateData['WELCOME']);
    case 'PASSWORD_RESET':
      return passwordResetTemplate(data as TemplateData['PASSWORD_RESET']);
    case 'TICKET_CONFIRMATION':
      return ticketConfirmationTemplate(
        data as TemplateData['TICKET_CONFIRMATION'],
      );
    case 'EVENT_PUBLISHED':
      return eventPublishedTemplate(data as TemplateData['EVENT_PUBLISHED']);
    case 'PAYOUT_COMPLETED':
      return payoutCompletedTemplate(data as TemplateData['PAYOUT_COMPLETED']);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown notification type: ${String(_exhaustive)}`);
    }
  }
}
