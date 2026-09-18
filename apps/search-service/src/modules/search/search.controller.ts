import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/common';
import { SearchService } from './search.service';
import { SearchProductsQueryDto, SearchProductsResponseDto } from './dto/search-products.dto';

/**
 * The only read endpoint on the read model.
 *
 * Public, like the catalog listing it complements: a shopper browses before
 * signing in. Results are the projection's copy, seconds behind catalog at
 * worst; each hit links to the product page, which reads catalog directly,
 * so the detail page stays the source of truth (docs/M12_SEARCH_PLAN.md §7).
 */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @Get('products')
  @ApiOperation({ summary: 'Search active products with a category facet, price range and sort' })
  @ApiOkResponse({ type: SearchProductsResponseDto })
  products(@Query() query: SearchProductsQueryDto): Promise<SearchProductsResponseDto> {
    return this.search.products(query);
  }
}
