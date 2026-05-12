import { EmailAttachment } from '../providers/email-provider.interface';
import { button, escapeHtml, layout } from './layout';
import { RenderedEmail, TemplateData } from './types';

const QR_CID = 'ticket-qr';

export function ticketConfirmationTemplate(
  data: TemplateData['TICKET_CONFIRMATION'],
): RenderedEmail {
  const eventDate = data.eventStart.toLocaleString('en-NG', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  });

  const venueLine = data.eventVenue
    ? `<tr><td style="color:#6b7280;padding:4px 0;width:120px;">Venue</td><td style="padding:4px 0;">${escapeHtml(data.eventVenue)}</td></tr>`
    : '';
  const eventLinkLine = data.eventUrl
    ? `<p style="margin:18px 0 0;">${button({ href: data.eventUrl, label: 'View event' })}</p>`
    : '';

  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#0f172a;">Your ticket is confirmed</h1>
    <p style="margin:0 0 18px;">Hi ${escapeHtml(data.buyerName)}, your ticket for <strong>${escapeHtml(data.eventName)}</strong> is ready.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px;font-size:14px;">
      <tr><td style="color:#6b7280;padding:4px 0;width:120px;">Event</td><td style="padding:4px 0;">${escapeHtml(data.eventName)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">When</td><td style="padding:4px 0;">${escapeHtml(eventDate)}</td></tr>
      ${venueLine}
      <tr><td style="color:#6b7280;padding:4px 0;">Ticket</td><td style="padding:4px 0;">${escapeHtml(data.ticketTypeName)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">Reference</td><td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(data.ticketReference)}</td></tr>
    </table>

    <div style="text-align:center;padding:18px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;margin:0 0 18px;">
      <img src="cid:${QR_CID}" alt="Ticket QR code" width="240" height="240" style="display:block;margin:0 auto;width:240px;height:240px;border:0;outline:none;text-decoration:none;" />
      <p style="margin:12px 0 0;font-size:13px;color:#6b7280;">Show this QR code at the entrance.</p>
    </div>

    ${eventLinkLine}
  `;

  const qrAttachment: EmailAttachment = {
    filename: 'ticket-qr.png',
    content: extractBase64(data.qrDataUrl),
    type: 'image/png',
    disposition: 'inline',
    contentId: QR_CID,
  };

  return {
    subject: `Your ticket for ${data.eventName} is confirmed 🎟️`,
    html: layout({
      preheader: `Your ${data.ticketTypeName} ticket — show the QR at the entrance.`,
      bodyHtml: body,
    }),
    attachments: [qrAttachment],
  };
}

function extractBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}
