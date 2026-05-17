import { button, escapeHtml, layout } from './layout';
import { RenderedEmail, TemplateData } from './types';

export function welcomeTemplate(data: TemplateData['WELCOME']): RenderedEmail {
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#0f172a;">Welcome to HostIT, ${escapeHtml(data.firstName)}!</h1>
    <p style="margin:0 0 14px;">
      We're glad to have you. HostIT is where Nigerian event organizers and
      attendees meet — discover local events, buy tickets, or list your own.
    </p>
    <p style="margin:0 0 22px;">Here are two ways to get started:</p>
    <ul style="margin:0 0 22px;padding-left:20px;">
      <li style="margin-bottom:6px;"><strong>Browse events</strong> happening near you.</li>
      <li><strong>Become an organizer</strong> and list your first event in minutes.</li>
    </ul>
    <p style="margin:0 0 24px;">${button({ href: data.browseEventsUrl, label: 'Browse events' })}</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">Questions? Reach us at <a href="mailto:${escapeHtml(data.supportEmail)}" style="color:#2563eb;">${escapeHtml(data.supportEmail)}</a>.</p>
  `;
  return {
    subject: 'Welcome to HostIT!',
    html: layout({
      preheader: `Welcome, ${data.firstName} — here's how to get started on HostIT.`,
      bodyHtml: body,
    }),
  };
}
