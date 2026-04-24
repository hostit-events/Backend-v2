import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { WalletsService } from './wallets.service';

@ApiTags('Admin / Wallets')
@ApiBearerAuth()
@Controller('admin/wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post(':userId/retry')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Retry Circle wallet creation for a user. Defaults to the first FAILED wallet; pass ?chain= to target a specific chain.',
  })
  retry(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('chain') chain?: string,
  ) {
    return this.walletsService.retryWalletCreation(userId, chain);
  }
}
