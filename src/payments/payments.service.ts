import {
  BadRequestException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import {
  CRYPTO_OPTION,
  fiatProvidersForCountry,
  type PaymentMethod,
  type ProviderConfig,
} from './country-providers.config';
import {
  IPaymentProvider,
  InitPaymentDto,
  PaymentInitResult,
  PaymentVerifyResult,
} from './interfaces/payment-provider.interface';
import { MonnifyProvider } from './providers/monnify.provider';
import { PaystackProvider } from './providers/paystack.provider';

/** Subset of Event that drives payment-method eligibility. */
export interface EventPaymentContext {
  country: string;
  currency: string;
  acceptsCrypto: boolean;
}

export type PaymentMethodOption =
  | {
      type: 'fiat';
      provider: PaymentProvider;
      methods: PaymentMethod[];
      default?: boolean;
    }
  | { type: 'crypto'; tokens: readonly string[] };

export interface PaymentMethodList {
  currency: string;
  country: string;
  methods: PaymentMethodOption[];
}

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
  private readonly providers: Partial<
    Record<PaymentProvider, IPaymentProvider>
  >;

  constructor(paystack: PaystackProvider, monnify: MonnifyProvider) {
    this.providers = {
      [PaymentProvider.PAYSTACK]: paystack,
      [PaymentProvider.MONNIFY]: monnify,
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

  /**
   * Buyer-facing list of payment options for an event. Frontend uses
   * this to render the checkout method picker — no country-specific
   * branching in the UI. Returns crypto only when no local fiat
   * provider is configured for the event's country and the event
   * accepts crypto; returns fiat + (optional) crypto otherwise.
   */
  listMethods(event: EventPaymentContext): PaymentMethodList {
    const fiatProviders = fiatProvidersForCountry(event.country);

    const methods: PaymentMethodOption[] = fiatProviders.map((p) =>
      this.toFiatOption(p),
    );

    if (event.acceptsCrypto) {
      methods.push({
        type: 'crypto',
        tokens: CRYPTO_OPTION.tokens,
      });
    }

    return {
      currency: event.currency,
      country: event.country,
      methods,
    };
  }

  /**
   * Throw if the buyer's chosen provider isn't actually eligible for
   * this event. Called from TicketsService.purchase before
   * initializePayment so a buyer can't spoof a request to use, say,
   * Stripe for an event Stripe doesn't serve.
   *
   * Crypto is treated as universal — eligible for any event with
   * acceptsCrypto=true regardless of country.
   */
  assertEligible(event: EventPaymentContext, provider: PaymentProvider): void {
    if (
      provider === PaymentProvider.CRYPTO ||
      provider === PaymentProvider.BLOCKRADAR
    ) {
      if (!event.acceptsCrypto) {
        throw new BadRequestException('Event does not accept crypto payments');
      }
      return;
    }

    const eligible = fiatProvidersForCountry(event.country).map((p) => p.id);
    if (!eligible.includes(provider)) {
      throw new BadRequestException(
        `${provider} is not available for events in ${event.country}. ` +
          `Eligible: ${eligible.length ? eligible.join(', ') : 'none — crypto only'}`,
      );
    }
  }

  private toFiatOption(p: ProviderConfig): PaymentMethodOption {
    return {
      type: 'fiat',
      provider: p.id,
      methods: p.methods,
      default: p.default,
    };
  }
}
