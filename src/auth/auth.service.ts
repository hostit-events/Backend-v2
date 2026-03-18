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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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

    // TODO: Queue Blockradar wallet creation (Phase 5)

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
      include: { organizerProfile: true },
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

  private maskAccountNumber(accountNumber: string): string {
    if (accountNumber.length <= 6) return '***';
    return accountNumber.slice(0, 3) + '****' + accountNumber.slice(-3);
  }

  private generateToken(userId: string, email: string, role: string): string {
    const payload = { sub: userId, email, role };
    return this.jwtService.sign(payload);
  }
}
