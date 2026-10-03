import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { OpenSearchClient } from './opensearch.client';
import { PRODUCTS_INDEX, PRODUCTS_INDEX_BODY } from './products.index';

export class RecreateIndexResponseDto {
  @ApiProperty({ example: PRODUCTS_INDEX }) index: string;
  @ApiProperty({ description: 'The mapping the empty index was created with.' })
  mapping: Record<string, unknown>;
  @ApiProperty({
    example: 'POST /catalog/admin/republish and POST /reviews/admin/republish',
    description: 'The write-side replay commands needed to repopulate the index.',
  })
  next: string;
}

/**
 * The read side's reset — half of a reindex. The other half is on the write
 * side, and the response says so.
 *
 * M13 Step 5: Search now projects from two write sides (catalog for product
 * fields, reviews for rating fields). Rebuilding the index now requires both
 * write sides to republish (docs/M13_REVIEWS_PLAN.md §5, §6).
 *
 * Not `@Public()`: it falls through to the gateway's guarded `@All`, so a
 * valid JWT is required. Staff-only in M16 (HANDOFF §9).
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search/admin')
export class AdminController {
  constructor(private readonly opensearch: OpenSearchClient) {}

  @Post('recreate-index')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Drop the products index and recreate it empty with the current mapping',
    description:
      'Every search returns nothing until both write sides republish. ' +
      'Run POST /catalog/admin/republish and POST /reviews/admin/republish next.',
  })
  @ApiOkResponse({ type: RecreateIndexResponseDto })
  async recreateIndex(): Promise<RecreateIndexResponseDto> {
    await this.opensearch.recreateIndex();
    return {
      index: PRODUCTS_INDEX,
      mapping: PRODUCTS_INDEX_BODY.mappings,
      next: 'POST /catalog/admin/republish and POST /reviews/admin/republish',
    };
  }
}
