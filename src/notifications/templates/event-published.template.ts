import { button, escapeHtml, layout } from './layout';
import { RenderedEmail, TemplateData } from './types';

export function eventPublishedTemplate(
  data: TemplateData['EVENT_PUBLISHED'],
): RenderedEmail {
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#0f172a;">Your event is live 🎉</h1>
    <p style="margin:0 0 14px;">Hi ${escapeHtml(data.organizerName)},</p>
    <p style="margin:0 0 22px;">
      <strong>${escapeHtml(data.eventName)}</strong> has been published. It's
      now discoverable on HostIT and ready to sell tickets.
    </p>
    <p style="margin:0 0 14px;">${button({ href: data.eventUrl, label: 'View event page' })}</p>
    <p style="margin:0 0 22px;">
      <a href="${escapeHtml(data.dashboardUrl)}" style="color:#2563eb;text-decoration:none;">Open the organizer dashboard</a> to track sales and check-ins.
    </p>
    <div style="margin:24px 0 0;padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb;">
      <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Share link</p>
      <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;">${escapeHtml(data.eventUrl)}</p>
    </div>
  `;
  return {
    subject: `Your event ${data.eventName} is now live!`,
    html: layout({
      preheader: `${data.eventName} is published and ready to sell tickets.`,
      bodyHtml: body,
    }),
  };
}
