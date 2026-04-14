import {
  BadRequestException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import {
  IPaymentProvider,
  InitPaymentDto,
  PaymentInitResult,
  PaymentVerifyResult,
} from './interfaces/payment-provider.interface';
import { PaystackProvider } from './providers/paystack.provider';

/**
 * Orchestrator that resolves the correct provider implementation for a
 * given `PaymentProvider` enum and delegates to it.
 *
 * Provider implementations are wired in their own PRs (#27 Paystack,
 * #28 Monnify). Until then, `resolveProvider` throws
 * `NotImplementedException` for unwired providers and
 * `BadRequestException` for unsupported enum values.
 */
@Injectable()
export class PaymentsService {
  /**
   * Internal registry of wired providers. Populated as each provider
   * lands. Kept private so callers go through `resolveProvider`.
   */
  private readonly providers: Partial<Record<PaymentProvider, IPaymentProvider>>;

  constructor(paystack: PaystackProvider) {
    this.providers = {
      [PaymentProvider.PAYSTACK]: paystack,
    };
  }

  resolveProvider(provider: PaymentProvider): IPaymentProvider {
    switch (provider) {
      case PaymentProvider.PAYSTACK:
      case PaymentProvider.MONNIFY:
      case PaymentProvider.BLOCKRADAR: {
        const impl = this.providers[provider];
        if (!impl) {
          throw new NotImplementedException(
            `Payment provider ${provider} is not yet wired up`,
          );
        }
        return impl;
      }
      default:
        throw new BadRequestException(
          `Unsupported payment provider: ${provider as string}`,
        );
    }
  }

  initializePayment(
    provider: PaymentProvider,
    data: InitPaymentDto,
  ): Promise<PaymentInitResult> {
    return this.resolveProvider(provider).initializePayment(data);
  }

  verifyPayment(
    provider: PaymentProvider,
    reference: string,
  ): Promise<PaymentVerifyResult> {
    return this.resolveProvider(provider).verifyPayment(reference);
  }
}
