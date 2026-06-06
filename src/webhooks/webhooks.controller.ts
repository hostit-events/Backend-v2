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
import { InjectQueue } from '@nestjs/bullmq';
import { ApiExcludeController } from '@nestjs/swagger';
import { PaymentProvider, Prisma, WebhookSource } from '@prisma/client';
import { Queue } from 'bullmq';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PaystackProvider } from '../payments/providers/paystack.provider';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  CircleWebhookService,
  type CircleNotification,
} from '../circle/circle-webhook.service';
import {
  CIRCLE_WEBHOOK_JOB,
  CIRCLE_WEBHOOK_QUEUE,
  type CircleWebhookJobData,
} from '../blockchain/circle-webhook.queue';
import { WebhooksService } from './webhooks.service';
import { MonnifyIpGuard } from './guards/monnify-ip.guard';
import { CircleIpGuard } from './guards/circle-ip.guard';

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
    private readonly prisma: PrismaService,
    private readonly circleVerifier: CircleWebhookService,
    @InjectQueue(CIRCLE_WEBHOOK_QUEUE)
    private readonly circleQueue: Queue<CircleWebhookJobData>,
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

  /**
   * Circle wallet/transaction lifecycle webhooks (#65). Authenticated by
   * ECDSA signature (and optional IP allowlist). Verified deliveries are
   * persisted to the WebhookEvent audit log and processed async via the
   * `circle-webhook` queue — we always return 200 immediately.
   *
   * Replay-safe at three layers: the (source, notificationId) unique
   * index here, the processedAt guard in the processor, and the
   * idempotent reconcile()/finalize() it calls.
   */
  @Public()
  @UseGuards(CircleIpGuard)
  @Post('circle')
  @HttpCode(HttpStatus.OK)
  async circleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-circle-signature') signature: string,
    @Headers('x-circle-key-id') keyId: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw) {
      this.logger.error('Circle webhook: raw body missing');
      throw new ForbiddenException('Invalid webhook');
    }

    const rawStr = raw.toString('utf8');
    const valid = await this.circleVerifier.verify(rawStr, signature, keyId);
    if (!valid) {
      this.logger.warn('Circle webhook: signature verification failed');
      throw new ForbiddenException('Invalid signature');
    }

    const body = JSON.parse(rawStr) as CircleNotification;

    // Persist the verified delivery to the audit log. The unique
    // (source, notificationId) index dedups re-deliveries; a duplicate
    // is acknowledged 200 without re-enqueueing.
    let event: { id: string };
    try {
      event = await this.prisma.webhookEvent.create({
        data: {
          source: WebhookSource.CIRCLE,
          notificationId: body.notificationId ?? null,
          type: body.notificationType ?? null,
          payload: body as unknown as Prisma.InputJsonValue,
          signatureValid: true,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Circle webhook: duplicate notificationId=${body.notificationId} — no-op`,
        );
        return { received: true };
      }
      throw err;
    }

    await this.circleQueue.add(
      CIRCLE_WEBHOOK_JOB,
      { webhookEventId: event.id },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    );

    return { received: true };
  }
}
