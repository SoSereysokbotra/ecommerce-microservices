import { Controller, Get, Headers, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER, Public } from '@libs/common';
import { RecommendationsService } from './recommendations.service';
import { GetRecommendationsQueryDto, RecommendationsResponseDto } from './dto/recommendations.dto';

@ApiTags('recommendations')
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  /**
   * Returns co-purchase recommendations for a product, enriched with catalog details.
   *
   * @Public() so anonymous shoppers browsing product pages can view recommendations.
   * Drops inactive or missing catalog products.
   * Returns an empty list `{ items: [], total: 0 }` for an unknown or unranked product, not a 404.
   */
  @Public()
  @Get('products/:productId')
  @ApiOperation({
    summary: 'Get enriched co-purchase product recommendations',
    description: 'Returns products frequently bought together with the requested product.',
  })
  @ApiParam({ name: 'productId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, type: RecommendationsResponseDto })
  async getRecommendations(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: GetRecommendationsQueryDto,
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<RecommendationsResponseDto> {
    return this.recommendationsService.getRecommendations(
      productId,
      query.limit ?? 4,
      correlationId,
    );
  }
}
