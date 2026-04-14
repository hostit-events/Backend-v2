import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PaystackProvider } from '../payments/providers/paystack.provider';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { WebhooksService } from './webhooks.service';
import { MonnifyIpGuard } from './guards/monnify-ip.guard';

/**
 * Provider webhooks. All endpoints are public — auth is by signature
 * (and IP whitelist for Monnify). Always return 200 quickly; provider
 * retries are exponential and noisy.
 */
@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly paystack: PaystackProvider,
    private readonly monnify: MonnifyProvider,
    private readonly webhooks: WebhooksService,
  ) {}

  @Public()
  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  async paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw) {
      this.logger.error('Paystack webhook: raw body missing');
      throw new ForbiddenException('Invalid webhook');
    }

    if (!this.paystack.verifyWebhookSignature(raw, signature)) {
      this.logger.warn('Paystack webhook: signature mismatch');
      throw new ForbiddenException('Invalid signature');
    }

    const body = JSON.parse(raw.toString('utf8')) as {
      event?: string;
      data?: {
        reference: string;
        amount: number;
        channel?: string;
        paid_at?: string;
        id?: number;
        /** Paystack reports gateway fees in kobo on charge.success. */
        fees?: number;
      };
    };

    const event = body.event;
    const data = body.data;
    if (!data?.reference) return { received: true };

    if (event === 'charge.success') {
      await this.webhooks.handleSuccess({
        reference: data.reference,
        provider: PaymentProvider.PAYSTACK,
        providerReference: data.id ? String(data.id) : data.reference,
        amount: data.amount / 100,
        channel: data.channel,
        paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
        gatewayFee: data.fees != null ? data.fees / 100 : undefined,
      });
    } else if (event === 'charge.failed') {
      await this.webhooks.handleFailure({
        reference: data.reference,
        provider: PaymentProvider.PAYSTACK,
      });
    } else {
      this.logger.log(`Paystack webhook: ignoring event=${event ?? 'unknown'}`);
    }

    return { received: true };
  }

  @Public()
  @UseGuards(MonnifyIpGuard)
  @Post('monnify')
  @HttpCode(HttpStatus.OK)
  async monnifyWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('monnify-signature') signature: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw) {
      this.logger.error('Monnify webhook: raw body missing');
      throw new ForbiddenException('Invalid webhook');
    }

    if (!this.monnify.verifyWebhookSignature(raw, signature)) {
      this.logger.warn('Monnify webhook: signature mismatch');
      throw new ForbiddenException('Invalid signature');
    }

    const body = JSON.parse(raw.toString('utf8')) as {
      eventType?: string;
      eventData?: {
        paymentReference: string;
        transactionReference: string;
        amountPaid: number;
        /** Total the buyer was charged including fees, when feeBearer=customer. */
        totalPayable?: number;
        /** Some Monnify payload versions ship the fee directly. */
        fee?: number;
        paymentMethod?: string;
        paidOn?: string;
      };
    };

    const eventType = body.eventType;
    const data = body.eventData;
    if (!data?.paymentReference) return { received: true };

    if (eventType === 'SUCCESSFUL_TRANSACTION') {
      // Monnify exposes the fee one of two ways depending on payload
      // version — prefer an explicit `fee` field when present, fall
      // back to (totalPayable - amountPaid) when feeBearer was the
      // customer (totalPayable > amountPaid). When feeBearer is the
      // organizer the fee comes out of the settlement, not the
      // checkout, so neither field is present and we leave it null
      // for a future settlement-webhook handler to fill in.
      const gatewayFee =
        data.fee != null
          ? data.fee
          : data.totalPayable != null && data.totalPayable > data.amountPaid
            ? data.totalPayable - data.amountPaid
            : undefined;

      await this.webhooks.handleSuccess({
        reference: data.paymentReference,
        provider: PaymentProvider.MONNIFY,
        providerReference: data.transactionReference,
        amount: data.amountPaid,
        channel: data.paymentMethod,
        paidAt: data.paidOn ? new Date(data.paidOn) : undefined,
        gatewayFee,
      });
    } else if (eventType === 'FAILED_TRANSACTION') {
      await this.webhooks.handleFailure({
        reference: data.paymentReference,
        provider: PaymentProvider.MONNIFY,
      });
    } else {
      this.logger.log(
        `Monnify webhook: ignoring eventType=${eventType ?? 'unknown'}`,
      );
    }

    return { received: true };
  }
}
