import { escapeHtml, layout } from './layout';
import { RenderedEmail, TemplateData } from './types';

export function payoutCompletedTemplate(
  data: TemplateData['PAYOUT_COMPLETED'],
): RenderedEmail {
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#0f172a;">Payout processed</h1>
    <p style="margin:0 0 14px;">Hi ${escapeHtml(data.organizerName)},</p>
    <p style="margin:0 0 22px;">
      We've processed your payout for <strong>${escapeHtml(data.eventName)}</strong>.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px;font-size:14px;">
      <tr><td style="color:#6b7280;padding:4px 0;width:150px;">Amount</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.amount)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">Bank</td><td style="padding:4px 0;">${escapeHtml(data.bankName)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">Account</td><td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(data.accountNumberMasked)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">Reference</td><td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(data.reference)}</td></tr>
    </table>

    <p style="margin:0;color:#6b7280;font-size:13px;">Funds typically arrive within 24 hours. If you don't see them after that, reply to this email and we'll look into it.</p>
  `;
  return {
    subject: `Payout processed for ${data.eventName}`,
    html: layout({
      preheader: `Your payout of ${data.amount} for ${data.eventName} has been processed.`,
      bodyHtml: body,
    }),
  };
}
