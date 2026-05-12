/**
 * Shared HTML shell for all notification emails. Inline CSS only — most
 * email clients strip <style> blocks. Mobile-first widths (max 600px),
 * system font stack, and a single accent colour keep the templates
 * portable.
 */
export function layout(opts: { preheader: string; bodyHtml: string }): string {
  const safePre = escapeHtml(opts.preheader);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HostIT</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${safePre}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <tr>
              <td style="background:#0f172a;padding:20px 28px;color:#ffffff;font-size:18px;font-weight:600;letter-spacing:0.2px;">HostIT</td>
            </tr>
            <tr>
              <td style="padding:28px;font-size:15px;line-height:1.55;color:#1f2937;">
                ${opts.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
                You're receiving this because of activity on your HostIT account.
                <br />
                © ${new Date().getFullYear()} HostIT. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function button(opts: { href: string; label: string }): string {
  return `<a href="${escapeAttr(opts.href)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(opts.label)}</a>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}
