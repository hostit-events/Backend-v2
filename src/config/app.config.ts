import { registerAs } from '@nestjs/config';

const API_PREFIX = process.env.API_PREFIX || 'api';

function resolveCallbackUrl(): string {
  if (process.env.PAYMENT_CALLBACK_URL) return process.env.PAYMENT_CALLBACK_URL;
  // Deliberately NOT falling back to APP_URL: that is the public *app*
  // origin used in email links, not the API origin, and silently
  // building an API path on top of it would be wrong the moment a
  // frontend exists. RENDER_EXTERNAL_URL is injected by Render and is
  // genuinely this service's own origin.
  const origin = process.env.RENDER_EXTERNAL_URL;
  if (!origin) return '';
  return `${origin.replace(/\/+$/, '')}/${API_PREFIX}/payments/callback`;
}

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: API_PREFIX,

  /**
   * Where the payment gateway redirects the buyer after checkout.
   *
   * CrowdPass has no web frontend — the buyer is inside the mobile app's
   * in-app browser — so this points at the API's own
   * `GET /api/payments/callback`, which settles the transaction and
   * renders a result page. The mobile WebView watches for this path,
   * closes the browser, and refreshes.
   *
   * Resolution order:
   *   1. PAYMENT_CALLBACK_URL — explicit override (a real frontend page,
   *      or a deep link, once one exists)
   *   2. RENDER_EXTERNAL_URL — injected automatically by Render, so a
   *      deploy needs no configuration at all
   *
   * There is deliberately NO localhost fallback. This key did not exist
   * at all before, so `configService.get('app.paymentCallbackUrl')`
   * always returned undefined and the hardcoded localhost default always
   * won — in production too. Every fiat buyer was redirected to
   * localhost:3000 after paying. `TicketsService` now refuses to boot in
   * production when this resolves to nothing.
   */
  paymentCallbackUrl: resolveCallbackUrl(),
}));
