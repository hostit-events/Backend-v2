import { EmailAttachment } from '../providers/email-provider.interface';

export type NotificationType =
  | 'WELCOME'
  | 'PASSWORD_RESET'
  | 'TICKET_CONFIRMATION'
  | 'EVENT_PUBLISHED'
  | 'PAYOUT_COMPLETED';

export interface TemplateData {
  WELCOME: {
    firstName: string;
    browseEventsUrl: string;
    supportEmail: string;
  };
  PASSWORD_RESET: {
    firstName: string;
    resetUrl: string;
  };
  TICKET_CONFIRMATION: {
    buyerName: string;
    eventName: string;
    eventStart: Date;
    eventVenue?: string;
    ticketTypeName: string;
    ticketReference: string;
    /** Data URL `data:image/png;base64,...` for the QR. */
    qrDataUrl: string;
    eventUrl?: string;
  };
  EVENT_PUBLISHED: {
    organizerName: string;
    eventName: string;
    eventUrl: string;
    dashboardUrl: string;
  };
  PAYOUT_COMPLETED: {
    organizerName: string;
    eventName: string;
    /** Already-formatted amount including currency, e.g. `₦250,000.00`. */
    amount: string;
    bankName: string;
    /** Account number masked to last 4 digits, e.g. `****1234`. */
    accountNumberMasked: string;
    reference: string;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}
