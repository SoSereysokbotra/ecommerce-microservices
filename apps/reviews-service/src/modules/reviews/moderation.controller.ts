import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { USER_ID_HEADER } from '@libs/common';
import { ReviewsService } from './reviews.service';
import {
  ListModerationQueryDto,
  ModerateDto,
  PaginatedModerationResponseDto,
  ReviewResponseDto,
} from './dto/review.dto';

/**
 * Staff moderation actions and write-side replay.
 *
 * M16 debt (HANDOFF §9): There are no roles until M16, so endpoints like
 * approve/reject and republish are currently protected by a valid JWT from the
 * gateway. Anyone with an account can call them until role checks land.
 */
@ApiTags('moderation')
@ApiHeader({ name: USER_ID_HEADER, description: 'Set by the gateway from the verified JWT.' })
@Controller('reviews')
export class ModerationController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Staff: list reviews in moderation queue (oldest first). */
  @Get('moderation')
  @ApiOperation({ summary: 'List reviews in moderation queue (staff)' })
  @ApiOkResponse({ type: PaginatedModerationResponseDto })
  listModeration(@Query() query: ListModerationQueryDto): Promise<PaginatedModerationResponseDto> {
    return this.reviews.listForModeration(query);
  }

  /** Write-side replay: re-emits product.rating_changed for every product rating. */
  @Post('admin/republish')
  @ApiOperation({ summary: 'Re-emit product.rating_changed for all ratings (staff replay)' })
  republish(): Promise<{ ratings: number }> {
    return this.reviews.republish();
  }

  /** Approve a pending or rejected review; bumps rollup and emits product.rating_changed. */
  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a review (staff)' })
  @ApiOkResponse({ type: ReviewResponseDto })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: ModerateDto,
  ): Promise<ReviewResponseDto> {
    return this.reviews.moderate(id, 'approve', body?.moderationNote);
  }

  /** Reject a pending or approved review; decrements rollup if approved. */
  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a review (staff)' })
  @ApiOkResponse({ type: ReviewResponseDto })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: ModerateDto,
  ): Promise<ReviewResponseDto> {
    return this.reviews.moderate(id, 'reject', body?.moderationNote);
  }
}
