import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { BecomeOrganizerDto } from './dto/become-organizer.dto';
import { PaystackService } from '../paystack/paystack.service';
import { MonnifyProvider } from '../payments/providers/monnify.provider';
import { WalletsService } from '../wallets/wallets.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly paystackService: PaystackService,
    private readonly monnifyProvider: MonnifyProvider,
    private readonly walletsService: WalletsService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const bcryptRounds = this.configService.get<number>(
      'auth.bcryptRounds',
      10,
    );
    const hashedPassword = await bcrypt.hash(dto.password, bcryptRounds);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
      },
    });

    // Enqueue Circle wallet creation. Async so registration latency
    // isn't tied to Circle availability; Bull retries on transient
    // failure and FAILED state is recoverable via the admin endpoint
    // (#64). register() always creates BUYER users, so no role gate
    // needed here — the processor is defensive regardless.
    try {
      await this.walletsService.enqueueWalletCreation(user.id);
    } catch (err) {
      // Redis/queue outage shouldn't block registration. The user
      // lands without a wallet; admin retry picks them up later.
      this.logger.warn(
        `Failed to enqueue wallet creation for user ${user.id}: ${(err as Error).message}`,
      );
    }

    // Re-read with wallets so the response reflects the PENDING row
    // flipped in by the enqueue. The address + circleWalletId populate
    // asynchronously — clients should poll /auth/me or subscribe to
    // the webhook (#65).
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: {
        wallets: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    const accessToken = this.generateToken(
      freshUser.id,
      freshUser.email,
      freshUser.role,
    );
    const {
      password: _pw,
      passwordResetToken: _prt,
      passwordResetExpires: _pre,
      ...userWithoutPassword
    } = freshUser;

    return {
      accessToken,
      user: userWithoutPassword,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = this.generateToken(user.id, user.email, user.role);
    const {
      password: _pw,
      passwordResetToken: _prt,
      passwordResetExpires: _pre,
      ...userWithoutPassword
    } = user;

    return {
      accessToken,
      user: userWithoutPassword,
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: hashedToken,
          passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      // TODO: Send email via notification service (Phase 7)
      this.logger.debug(`Password reset token for ${dto.email}: ${rawToken}`);
    }

    return {
      message:
        'If an account with that email exists, a password reset link has been sent.',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const hashedToken = crypto
      .createHash('sha256')
      .update(dto.token)
      .digest('hex');

    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const bcryptRounds = this.configService.get<number>(
      'auth.bcryptRounds',
      10,
    );
    const hashedPassword = await bcrypt.hash(dto.newPassword, bcryptRounds);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    return { message: 'Password has been reset successfully.' };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        organizerProfile: true,
        wallets: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const {
      password: _pw,
      passwordResetToken: _prt,
      passwordResetExpires: _pre,
      ...userData
    } = user;

    let organizerProfile: Record<string, unknown> | null = null;
    if (userData.organizerProfile) {
      const {
        bvn: _bvn,
        id: _id,
        userId: _opUserId,
        ...profileData
      } = userData.organizerProfile;
      organizerProfile = {
        ...profileData,
        accountNumber: profileData.accountNumber
          ? this.maskAccountNumber(profileData.accountNumber)
          : null,
      };
    }

    return {
      ...userData,
      organizerProfile,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName && { firstName: dto.firstName }),
        ...(dto.lastName && { lastName: dto.lastName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
    });

    const {
      password: _pw,
      passwordResetToken: _prt,
      passwordResetExpires: _pre,
      ...result
    } = user;
    return result;
  }

  async becomeOrganizer(userId: string, dto: BecomeOrganizerDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organizerProfile: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.role === UserRole.ORGANIZER) {
      throw new ConflictException('User is already an organizer');
    }

    if (user.organizerProfile) {
      throw new ConflictException('Organizer profile already exists');
    }

    // Verify BVN via Paystack. Paystack's BVN endpoint is a NIBSS
    // passthrough that's typically not provisioned on test accounts —
    // setting `SKIP_BVN_VERIFICATION=true` bypasses the call so the
    // rest of the organizer flow is testable in dev. Production env
    // validation should reject this flag.
    const skipBvn =
      this.configService.get<string>('SKIP_BVN_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    let bvnData: { bvn: string; firstName: string; lastName: string };
    if (skipBvn) {
      this.logger.warn(
        `[DEV] Skipping BVN verification for user ${userId} (SKIP_BVN_VERIFICATION=true)`,
      );
      bvnData = { bvn: dto.bvn, firstName: 'Dev', lastName: 'Bypass' };
    } else {
      try {
        bvnData = await this.paystackService.resolveBvn(dto.bvn);
      } catch {
        throw new BadRequestException('BVN verification failed');
      }
    }

    // Verify bank account via Paystack. Skipped in dev when
    // SKIP_BANK_VERIFICATION=true — the Paystack and Monnify sandboxes
    // accept mutually exclusive test bank data, so doing the upfront
    // check blocks the other provider's sub-account creation. With the
    // flag on, we trust user-provided values and let each provider's
    // sub-account-create call validate independently.
    const skipBank =
      this.configService.get<string>('SKIP_BANK_VERIFICATION') === 'true' &&
      this.configService.get<string>('NODE_ENV') !== 'production';

    let bankData: { accountNumber: string; accountName: string };
    if (skipBank) {
      this.logger.warn(
        `[DEV] Skipping bank verification for user ${userId} (SKIP_BANK_VERIFICATION=true)`,
      );
      bankData = {
        accountNumber: dto.accountNumber,
        accountName: `${user.firstName} ${user.lastName}`.toUpperCase(),
      };
    } else {
      try {
        bankData = await this.paystackService.resolveBankAccount(
          dto.accountNumber,
          dto.bankCode,
        );
      } catch {
        throw new BadRequestException('Bank account verification failed');
      }
    }

    // Create the Paystack and Monnify subaccounts that will receive
    // this organizer's settlement payouts. Both calls are non-blocking
    // — provider outages shouldn't stop role upgrade. Admin can retry
    // via a backfill endpoint later (PR follow-up). Run in parallel
    // since they're independent and we don't want to double the
    // /become-organizer latency for the happy path.
    const [paystackResult, monnifyResult] = await Promise.allSettled([
      this.paystackService.createSubaccount({
        businessName: bankData.accountName,
        bankCode: dto.bankCode,
        accountNumber: bankData.accountNumber,
      }),
      this.monnifyProvider.createSubAccount({
        bankCode: dto.bankCode,
        accountNumber: bankData.accountNumber,
        email: user.email,
      }),
    ]);

    const paystackSubaccount =
      paystackResult.status === 'fulfilled' ? paystackResult.value : null;
    if (paystackResult.status === 'rejected') {
      this.logger.warn(
        `Paystack subaccount creation failed for user ${userId}: ${(paystackResult.reason as Error).message}`,
      );
    }

    const monnifySubAccount =
      monnifyResult.status === 'fulfilled' ? monnifyResult.value : null;
    if (monnifyResult.status === 'rejected') {
      this.logger.warn(
        `Monnify sub-account creation failed for user ${userId}: ${(monnifyResult.reason as Error).message}`,
      );
    }

    // Create organizer profile and upgrade role in a transaction
    const [_updatedUser, organizerProfile] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.ORGANIZER },
      }),
      this.prisma.organizerProfile.create({
        data: {
          userId,
          bvn: dto.bvn,
          bvnVerified: true,
          bankCode: dto.bankCode,
          accountNumber: bankData.accountNumber,
          accountName: bankData.accountName,
          bankName: bvnData.firstName, // Will be replaced with actual bank name lookup
          bankVerified: true,
          kycTier: 'BASIC',
          kycStatus: 'VERIFIED',
          paystackSubaccountCode: paystackSubaccount?.subaccountCode ?? null,
          paystackSubaccountId:
            paystackSubaccount?.id != null
              ? String(paystackSubaccount.id)
              : null,
          monnifySubAccountCode: monnifySubAccount?.subAccountCode ?? null,
        },
      }),
    ]);

    this.logger.log(`User ${userId} upgraded to ORGANIZER`);

    const {
      bvn: _bvn,
      id: _id,
      userId: _opUserId,
      ...profileData
    } = organizerProfile;

    return {
      message: 'Successfully upgraded to organizer',
      organizerProfile: {
        ...profileData,
        accountNumber: this.maskAccountNumber(profileData.accountNumber!),
      },
    };
  }

  private maskAccountNumber(accountNumber: string): string {
    if (accountNumber.length <= 6) return '***';
    return accountNumber.slice(0, 3) + '****' + accountNumber.slice(-3);
  }

  private generateToken(userId: string, email: string, role: string): string {
    const payload = { sub: userId, email, role };
    return this.jwtService.sign(payload);
  }
}
