export interface EmailAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  /** MIME type, e.g. `image/png`. */
  type: string;
  /** `inline` for content-id referenced bodies, `attachment` for downloads. */
  disposition?: 'inline' | 'attachment';
  /** Required when `disposition: inline` — referenced as `cid:<contentId>`. */
  contentId?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
