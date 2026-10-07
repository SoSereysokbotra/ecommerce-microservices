import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER } from '@libs/common';
import { ReplayService } from './replay.service';
import { ReplayCoPurchasesResponseDto } from './dto/replay.dto';

/**
 * Admin replay for recommendations read model.
 *
 * Walks every CONFIRMED order and appends an `order.co_purchase_replay` outbox
 * event containing the order's purchased product IDs (M14 plan §7, §13).
 *
 * ## The Trap: Double counting
 *
 * `handleOnce` in recommendations-service keys on event ID. Replay events generate
 * fresh event IDs, meaning idempotency markers from original `order.confirmed`
 * facts do NOT block the replay (which is what allows rebuilding the projection).
 * However, replaying onto an existing table would double all co-purchase counts.
 *
 * Therefore, operators must reset/truncate product_recommendations before replaying
 * (e.g., via POST /recommendations/admin/reset).
 *
 * Staff-only in M16 (HANDOFF §9). Until then the gateway's JWT check is the only gate.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders/admin')
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
