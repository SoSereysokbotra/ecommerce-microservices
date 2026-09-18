import { Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CORRELATION_ID_HEADER } from '@libs/common';
import { RepublishResult, RepublishService } from './republish.service';

export class RepublishResponseDto implements RepublishResult {
  @ApiProperty({ description: 'product.updated events appended, one per product.' })
  products: number;

  @ApiProperty({ description: 'category.updated events appended, one per category.' })
  categories: number;
}

/**
 * Staff-only in M16. Until then the gateway's JWT check is the only gate —
 * the same debt as creating a product or dispatching a parcel, and listed
 * with them in HANDOFF §9.
 */
@ApiTags('catalog')
@Controller('catalog/admin')
export class RepublishController {
  constructor(private readonly republish: RepublishService) {}

  /**
   * 200, not 201 — nothing is created that a client could fetch; rows are
   * appended to the outbox and gone within a second.
   */
  @Post('republish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-announce every product and category at its current version',
    description:
      'The write-side half of a search reindex. Safe against a live index: ' +
      'every consumer write is versioned, so nothing newer is overwritten.',
  })
  @ApiOkResponse({ type: RepublishResponseDto })
  republishAll(
    @Headers(CORRELATION_ID_HEADER) correlationId?: string,
  ): Promise<RepublishResponseDto> {
    return this.republish.republishAll(correlationId);
  }
}
