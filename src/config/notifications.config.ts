import { registerAs } from '@nestjs/config';

export default registerAs('notifications', () => ({
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY,
    fromEmail: process.env.SENDGRID_FROM_EMAIL,
  },
  // Public-facing URL used to build deep links inside emails (password
  // reset, share links, organizer dashboard). No trailing slash.
  appUrl: process.env.APP_URL || 'https://hostit.events',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@hostit.events',
}));
