import { button, escapeHtml, layout } from './layout';
import { RenderedEmail, TemplateData } from './types';

export function passwordResetTemplate(
  data: TemplateData['PASSWORD_RESET'],
): RenderedEmail {
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#0f172a;">Reset your password</h1>
    <p style="margin:0 0 14px;">Hi ${escapeHtml(data.firstName)},</p>
    <p style="margin:0 0 22px;">
      We received a request to reset the password for your HostIT account.
      Click the button below to choose a new one.
    </p>
    <p style="margin:0 0 22px;">${button({ href: data.resetUrl, label: 'Reset password' })}</p>
    <p style="margin:0 0 14px;color:#6b7280;font-size:13px;">This link expires in 1 hour.</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `;
  return {
    subject: 'Reset your HostIT password',
    html: layout({
      preheader: 'A request was made to reset your HostIT password.',
      bodyHtml: body,
    }),
  };
}
