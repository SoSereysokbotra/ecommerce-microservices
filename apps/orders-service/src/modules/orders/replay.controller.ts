import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Roles } from '@libs/common';
import { UserRole } from '@libs/shared-types';
import { ReplayService } from './replay.service';
import { ReplayCoPurchasesResponseDto } from './dto/replay.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders/admin')
@Roles(UserRole.ADMIN, UserRole.STAFF)
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Post('replay-co-purchases')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-announce co-purchase pairs for all confirmed orders',
    description:
      'Appends one order.co_purchase_replay event per confirmed order to the outbox. ' +
      'Bound only to recommendations-service. ' +
      'Truncate product_recommendations before replaying, or counts double.',
  })
  @ApiOkResponse({ type: ReplayCoPurchasesResponseDto })
  async replayCoPurchases(
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<ReplayCoPurchasesResponseDto> {
    const orders = await this.replay.replayCoPurchases(correlationId);
    return {
      orders,
      next: 'Truncate product_recommendations before replaying, or counts double.',
    };
  }
}
