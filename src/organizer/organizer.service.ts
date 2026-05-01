import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { PaystackService } from '../paystack/paystack.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnableMonnifyDto } from './dto/enable-monnify.dto';
import { EnablePaystackDto } from './dto/enable-paystack.dto';

/**
 * Per-provider fiat enablement for organizers.
 *
 * Onboarding shifted from "BVN+bank+subaccounts at /become-organizer"
 * to "no KYC at signup; KYC and subaccount creation happen here, per
 * provider, when the organizer wants to accept fiat for an event."
 *
 * Each enable endpoint takes the provider-specific KYC + bank fields,
 * verifies them, creates the provider-side subaccount, and writes the
 * relevant columns onto OrganizerProfile. Once any fiat provider is
 * enabled for a country, events in that country can list that
 * provider as a checkout option.
 */
@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly paystack: PaystackService,
    private readonly monnify: MonnifyProvider,
  ) {}

  async enablePaystack(userId: string, dto: EnablePaystackDto) {
    const { profile, user } = await this.loadOrganizer(userId);

    if (profile.paystackSubaccountCode) {
      throw new ConflictException(
        'Paystack is already enabled for this organizer',
      );
    }

    const bvnData = await this.verifyBvn(userId, dto.bvn);
    const bankData = await this.verifyBankAccount(
      user,
      dto.accountNumber,
      dto.bankCode,
    );

    const subaccount = await this.paystack
      .createSubaccount({
        businessName: bankData.accountName,
        bankCode: dto.bankCode,
        accountNumber: bankData.accountNumber,
      })
      .catch((err: Error) => {
        this.logger.warn(
          `Paystack subaccount creation failed for user ${userId}: ${err.message}`,
        );
        throw new BadRequestException(
          'Could not create Paystack subaccount. Please verify the bank details and try again.',
        );
      });

    await this.prisma.organizerProfile.update({
      where: { id: profile.id },
      data: {
        bvn: dto.bvn,
        bvnVerified: true,
        bankCode: dto.bankCode,
        accountNumber: bankData.accountNumber,
        accountName: bankData.accountName,
        bankName: bvnData.firstName, // best-effort — replaced by a real bank-name lookup later
        bankVerified: true,
        kycTier: 'BASIC',
        kycStatus: 'VERIFIED',
        paystackSubaccountCode: subaccount.subaccountCode,
        paystackSubaccountId:
          subaccount.id != null ? String(subaccount.id) : null,
      },
    });

    this.logger.log(`Paystack enabled for user ${userId}`);
    return {
      message:
        'Paystack is now enabled. NGN events can use Paystack at checkout.',
      provider: 'PAYSTACK',
    };
  }

  async enableMonnify(userId: string, dto: EnableMonnifyDto) {
    const { profile, user } = await this.loadOrganizer(userId);

    if (profile.monnifySubAccountCode) {
      throw new ConflictException(
        'Monnify is already enabled for this organizer',
      );
    }

    // BVN/bank verification only runs when not already done by another
    // provider's enable. If Paystack already verified, reuse those
    // fields; otherwise verify now and persist.
    let bvn = profile.bvn ?? dto.bvn;
    let bankCode = profile.bankCode ?? dto.bankCode;
    let accountNumber = profile.accountNumber ?? dto.accountNumber;
    let accountName = profile.accountName;

    if (!profile.bvnVerified) {
      const bvnData = await this.verifyBvn(userId, dto.bvn);
      bvn = dto.bvn;
      // bvnData provides the legal name — first/last from NIBSS
      accountName ??= `${bvnData.firstName} ${bvnData.lastName}`.toUpperCase();
    }
    if (!profile.bankVerified) {
      const bankData = await this.verifyBankAccount(
        user,
        dto.accountNumber,
        dto.bankCode,
      );
      bankCode = dto.bankCode;
      accountNumber = bankData.accountNumber;
      accountName = bankData.accountName;
    }

    const subAccount = await this.monnify
      .createSubAccount({
        bankCode,
        accountNumber,
        email: user.email,
      })
      .catch((err: Error) => {
        this.logger.warn(
          `Monnify sub-account creation failed for user ${userId}: ${err.message}`,
        );
        throw new BadRequestException(
          'Could not create Monnify sub-account. Please verify the bank details and try again.',
        );
      });

    await this.prisma.organizerProfile.update({
      where: { id: profile.id },
      data: {
        bvn,
        bvnVerified: true,
        bankCode,
        accountNumber,
        accountName,
        bankVerified: true,
        kycTier: profile.kycTier === 'NONE' ? 'BASIC' : profile.kycTier,
        kycStatus: 'VERIFIED',
        monnifySubAccountCode: subAccount.subAccountCode,
      },
    });

    this.logger.log(`Monnify enabled for user ${userId}`);
    return {
      message:
        'Monnify is now enabled. NGN events can use Monnify at checkout.',
      provider: 'MONNIFY',
    };
  }

  // ---------- internals ----------

  private async loadOrganizer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organizerProfile: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== UserRole.ORGANIZER) {
      throw new ForbiddenException(
        'You must call /become-organizer before enabling fiat providers',
      );
    }
    if (!user.organizerProfile) {
      // Defensive — becomeOrganizer always creates the row, but if a
      // legacy account is missing one we surface clearly.
      throw new NotFoundException(
        'Organizer profile missing — re-run /become-organizer',
      );
    }
    return { user, profile: user.organizerProfile };
  }

  /**
   * BVN check — Paystack's NIBSS passthrough. Skipped via
   * SKIP_BVN_VERIFICATION=true in dev (Paystack test accounts rarely
   * have NIBSS provisioned).
   */
  private async verifyBvn(
    userId: string,
    bvn: string,
  ): Promise<{ bvn: string; firstName: string; lastName: string }> {
    const skip =
      this.configService.get<string>('SKIP_BVN_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    if (skip) {
      this.logger.warn(
        `[DEV] Skipping BVN verification for user ${userId} (SKIP_BVN_VERIFICATION=true)`,
      );
      return { bvn, firstName: 'Dev', lastName: 'Bypass' };
    }

    try {
      return await this.paystack.resolveBvn(bvn);
    } catch {
      throw new BadRequestException('BVN verification failed');
    }
  }

  /**
   * Bank-account name resolution via Paystack. Same dev skip story.
   * Falls back to the user's name when skipped.
   */
  private async verifyBankAccount(
    user: { firstName: string; lastName: string },
    accountNumber: string,
    bankCode: string,
  ): Promise<{ accountNumber: string; accountName: string }> {
    const skip =
      this.configService.get<string>('SKIP_BANK_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    if (skip) {
      this.logger.warn(
        `[DEV] Skipping bank verification (SKIP_BANK_VERIFICATION=true)`,
      );
      return {
        accountNumber,
        accountName: `${user.firstName} ${user.lastName}`.toUpperCase(),
      };
    }

    try {
      return await this.paystack.resolveBankAccount(accountNumber, bankCode);
    } catch {
      throw new BadRequestException('Bank account verification failed');
    }
  }
}
