import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ResolvedBankAccount {
  accountNumber: string;
  accountName: string;
}

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly secretKey: string;
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly configService: ConfigService) {
    this.secretKey =
      this.configService.getOrThrow<string>('paystack.secretKey');
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    const data = (await response.json()) as {
      status: boolean;
      message: string;
      data: T;
    };

    if (!response.ok || !data.status) {
      this.logger.error(`Paystack API error: ${data.message}`);
      throw new BadRequestException(
        data.message || 'Paystack API request failed',
      );
    }

    return data.data;
  }

  async resolveBankAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<ResolvedBankAccount> {
    const params = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode,
    });
    const data = await this.request<{
      account_number: string;
      account_name: string;
    }>(`/bank/resolve?${params.toString()}`);

    return {
      accountNumber: data.account_number,
      accountName: data.account_name,
    };
  }

  async resolveBvn(
    bvn: string,
  ): Promise<{ bvn: string; firstName: string; lastName: string }> {
    const data = await this.request<{
      bvn: string;
      first_name: string;
      last_name: string;
    }>(`/bank/resolve_bvn/${bvn}`);

    return {
      bvn: data.bvn,
      firstName: data.first_name,
      lastName: data.last_name,
    };
  }
}
