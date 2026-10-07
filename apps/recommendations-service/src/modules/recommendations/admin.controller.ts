import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RecommendationsService } from './recommendations.service';

export class ResetRecommendationsResponseDto {
  @ApiProperty({
    description: 'Whether the recommendations read table and markers were cleared.',
    example: true,
  })
  cleared: boolean;

  @ApiProperty({
    description: 'The write-side replay command to repopulate the graph.',
    example: 'POST /orders/admin/replay-co-purchases',
  })
  next: string;
}

/**
 * The read side's reset — half of a co-purchase rebuild (M14 plan §7, §13).
 * The other half is on the write side (POST /orders/admin/replay-co-purchases).
 *
 * ## The Trap: Double counting
 *
 * `handleOnce` keys on event ID. Replay events generate fresh event IDs, meaning
 * original `order.confirmed` idempotency markers do not block a replay.
 * However, replaying onto an existing table doubles all co-purchase counts.
 *
 * Resetting truncates `product_recommendations` and clears `processed_events` markers
 * for recommendations-service so the write side replay starts with a clean slate.
 *
 * Staff-only in M16 (HANDOFF §9). Guarded by the gateway's JWT check.
 */
@ApiTags('recommendations')
@ApiBearerAuth()
@Controller('recommendations/admin')
export class AdminController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Truncate product recommendations and reset idempotency markers',
    description:
      'The read side reset — half of a co-purchase rebuild. The other half is on ' +
      'the write side (POST /orders/admin/replay-co-purchases). Truncates ' +
      'product_recommendations and clears processed_events so replay starts clean.',
  })
  @ApiOkResponse({ type: ResetRecommendationsResponseDto })
  async reset(): Promise<ResetRecommendationsResponseDto> {
    await this.recommendations.reset();
    return {
      cleared: true,
      next: 'POST /orders/admin/replay-co-purchases',
    };
  }
}
