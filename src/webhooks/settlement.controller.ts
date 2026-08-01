import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PaymentProvider, TransactionStatus } from '@prisma/client';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';

/** Outcome of a settlement attempt, shared by both routes below. */
export interface SettleOutcome {
  reference: string;
  status: TransactionStatus;
  settled: boolean;
  /** Set when settlement was refused rather than merely unfinished. */
  error?: string;
}

/**
 * Payment settlement surface.
 *
 * Why this exists: settlement used to depend entirely on the provider
 * webhook. When that webhook never arrived — which is the current state,
 * with zero fiat transactions ever reaching SUCCESS — transactions sat
 * PENDING forever: money taken by the gateway, no ticket minted, nothing
 * on the organizer dashboard, and no way to recover. Both routes here
 * give the buyer's own return trip a chance to settle the transaction.
 *
 * Both funnel into the *same* `WebhooksService` methods the webhook uses
 * rather than reimplementing settlement. Those are already idempotent —
 * they no-op on any transaction that isn't PENDING — so a webhook and a
 * callback racing each other is safe, and whichever lands first wins.
 *
 * Lives in WebhooksModule rather than PaymentsModule because
 * `WebhooksService` needs `MintQueueService`, and
 * PaymentsModule -> BlockchainModule -> TicketsModule -> PaymentsModule
 * would be a dependency cycle. The route paths are still `/payments/*`.
 */
@ApiTags('Payments')
@Controller('payments')
export class SettlementController {
  private readonly logger = new Logger(SettlementController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Where the payment gateway redirects the buyer after checkout.
   *
   * CrowdPass has no web frontend — the buyer is inside the mobile app's
   * in-app browser. So this page has to live on the API: it is the
   * stable https URL the gateway redirects to and the WebView watches
   * for. On navigation to this path the app should close the browser and
   * refresh its state.
   *
   * Settlement happens here, on the redirect itself, so the ticket is
   * minted even if the app never calls `/payments/verify` and even if the
   * provider webhook never arrives. The HTML is fully self-contained —
   * no external assets — because it renders inside a WebView that may be
   * on poor connectivity.
   *
   * Uses `@Res()` and writes the response directly so the global
   * TransformInterceptor can't wrap the HTML in the JSON envelope.
   *
   * Providers disagree on the query parameter name, so accept all of
   * them: Paystack sends `reference` and `trxref`, Monnify sends
   * `paymentReference`.
   */
  @Get('callback')
  @Public()
  @ApiExcludeEndpoint()
  async callback(
    @Res() res: Response,
    @Query('reference') reference?: string,
    @Query('trxref') trxref?: string,
    @Query('paymentReference') paymentReference?: string,
  ): Promise<void> {
    const ref = (reference || trxref || paymentReference || '').trim();

    let outcome: SettleOutcome;
    if (!ref) {
      outcome = {
        reference: '',
        status: TransactionStatus.PENDING,
        settled: false,
        error: 'No payment reference was supplied.',
      };
    } else {
      try {
        outcome = await this.settle(ref);
      } catch (err) {
        // Never surface a stack trace into the buyer's browser, and
        // never 500 here — the money may well have left their account,
        // so the page must still render something coherent.
        this.logger.error(
          `Callback settlement failed for ${ref}: ${(err as Error).message}`,
        );
        outcome = {
          reference: ref,
          status: TransactionStatus.PENDING,
          settled: false,
          error:
            'We could not confirm this payment automatically. If you were ' +
            'charged, your ticket will be issued shortly.',
        };
      }
    }

    res
      .status(200)
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .send(this.page(outcome));
  }

  /**
   * Machine-readable settlement check for the mobile app. Safe to poll —
   * bank transfers in particular can stay pending for minutes.
   */
  @Get('verify')
  @Public()
  @ApiOperation({
    summary:
      'Verify and settle a transaction by reference (called on return from checkout)',
  })
  @ApiQuery({ name: 'reference', required: true, type: String })
  async verify(@Query('reference') reference: string): Promise<SettleOutcome> {
    if (!reference?.trim()) {
      throw new BadRequestException('reference is required');
    }
    return this.settle(reference.trim());
  }

  // ---------- internals ----------

  private async settle(reference: string): Promise<SettleOutcome> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { reference },
      select: {
        id: true,
        reference: true,
        provider: true,
        status: true,
        amount: true,
        currency: true,
      },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    // Already terminal — report and stop. Re-verifying a settled
    // transaction against the gateway buys nothing and costs a round trip.
    if (transaction.status !== TransactionStatus.PENDING) {
      return this.shape(transaction.reference, transaction.status);
    }

    // Crypto settles through the Circle webhook, not a fiat gateway.
    if (
      transaction.provider === PaymentProvider.CRYPTO ||
      transaction.provider === PaymentProvider.BLOCKRADAR
    ) {
      return this.shape(transaction.reference, transaction.status);
    }

    const result = await this.payments.verifyPayment(
      transaction.provider,
      transaction.reference,
    );

    if (result.status === 'success') {
      // Guard against a tampered or mismatched amount before minting.
      // `verifyPayment` normalizes to NGN, as does Transaction.amount.
      const expected = Number(transaction.amount);
      if (result.amount < expected) {
        this.logger.error(
          `Underpayment on ${transaction.reference}: gateway reported ` +
            `${result.amount} ${transaction.currency}, expected ${expected}. ` +
            `Not settling.`,
        );
        return {
          reference: transaction.reference,
          status: TransactionStatus.PENDING,
          settled: false,
          error: 'Payment amount does not match the order.',
        };
      }

      await this.webhooks.handleSuccess({
        reference: transaction.reference,
        provider: transaction.provider,
        providerReference: result.providerReference,
        amount: result.amount,
        channel: result.channel,
        paidAt: result.paidAt,
      });
      this.logger.log(
        `Settled ${transaction.reference} on return from checkout ` +
          `(${transaction.provider})`,
      );
      return this.shape(transaction.reference, TransactionStatus.SUCCESS);
    }

    if (result.status === 'failed') {
      await this.webhooks.handleFailure({
        reference: transaction.reference,
        provider: transaction.provider,
      });
      return this.shape(transaction.reference, TransactionStatus.FAILED);
    }

    // Still pending at the gateway — the caller should poll.
    return this.shape(transaction.reference, TransactionStatus.PENDING);
  }

  private shape(reference: string, status: TransactionStatus): SettleOutcome {
    return {
      reference,
      status,
      settled: status === TransactionStatus.SUCCESS,
    };
  }

  /**
   * Minimal self-contained result page. The `<meta name="cp-status">`
   * tags and `#cp-result` data attributes are the contract for the
   * mobile WebView — it can read either instead of scraping visible
   * copy, which is free to change.
   */
  page(outcome: SettleOutcome): string {
    const ok = outcome.settled;
    const failed = outcome.status === TransactionStatus.FAILED;

    const heading = ok
      ? 'Payment confirmed'
      : failed
        ? 'Payment failed'
        : 'Payment processing';
    const body = outcome.error
      ? outcome.error
      : ok
        ? 'Your ticket is being issued. You can return to the app.'
        : failed
          ? 'This payment did not go through. You have not been charged.'
          : 'This is taking a moment to confirm. You can return to the app — ' +
            'your ticket will appear once payment clears.';
    const accent = ok ? '#0f9d58' : failed ? '#d93025' : '#f4b400';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="cp-status" content="${esc(outcome.status)}">
<meta name="cp-settled" content="${ok ? 'true' : 'false'}">
<meta name="cp-reference" content="${esc(outcome.reference)}">
<title>${esc(heading)} — CrowdPass</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #fff; color: #1f1f1f;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #121212; color: #ececec; }
    .ref { background: #1e1e1e; }
  }
  .card { max-width: 22rem; width: 100%; text-align: center; }
  .dot {
    width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 20px;
    background: ${accent}; display: flex; align-items: center;
    justify-content: center; color: #fff; font-size: 30px; line-height: 1;
  }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 20px; opacity: .8; }
  .ref {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .75rem; opacity: .65; word-break: break-all;
    background: #f4f4f4; padding: 8px 10px; border-radius: 6px;
  }
</style>
</head>
<body>
  <main class="card" id="cp-result"
        data-status="${esc(outcome.status)}"
        data-settled="${ok ? 'true' : 'false'}"
        data-reference="${esc(outcome.reference)}">
    <div class="dot">${ok ? '&check;' : failed ? '&times;' : '&hellip;'}</div>
    <h1>${esc(heading)}</h1>
    <p>${esc(body)}</p>
    ${outcome.reference ? `<div class="ref">${esc(outcome.reference)}</div>` : ''}
  </main>
</body>
</html>`;
  }
}

/** Escape untrusted values before interpolating into the result page. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
