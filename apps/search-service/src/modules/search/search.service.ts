import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OpenSearchClient } from './opensearch.client';
import { ProductDocument } from './product-document';
import { PRODUCTS_INDEX } from './products.index';
import { FACET_AGG, FACET_NAME_AGG, SearchQueryInput, buildSearchBody } from './search-query';
import {
  CategoryFacetDto,
  SearchHitDto,
  SearchProductsResponseDto,
} from './dto/search-products.dto';

interface Bucket {
  key: string;
  doc_count: number;
  [FACET_NAME_AGG]?: { buckets: { key: string }[] };
}

interface SearchResponseBody {
  hits: { total: { value: number }; hits: { _source: ProductDocument }[] };
  aggregations?: { [FACET_AGG]?: { buckets: Bucket[] } };
}

/**
 * The read side, read. Runs the query `search-query.ts` builds and shapes
 * the answer; nothing here writes.
 *
 * A cluster that cannot be reached is a **503**, not a 400 or a 500 — the
 * same rule pricing's `CatalogClient` learned in M8: tell the caller whose
 * fault it is, so a client that retries knows to.
 */
@Injectable()
export class SearchService {
  constructor(private readonly opensearch: OpenSearchClient) {}

  async products(input: SearchQueryInput): Promise<SearchProductsResponseDto> {
    let body: SearchResponseBody;
    try {
      const response = await this.opensearch.raw.search({
        index: PRODUCTS_INDEX,
        body: buildSearchBody(input),
      });
      body = response.body as SearchResponseBody;
    } catch {
      throw new ServiceUnavailableException({
        message: 'search is temporarily unavailable',
        error: 'Service Unavailable',
      });
    }

    return {
      hits: body.hits.hits.map((hit) => toHit(hit._source)),
      total: body.hits.total.value,
      page: input.page,
      limit: input.limit,
      facets: { categories: toFacets(body.aggregations?.[FACET_AGG]?.buckets ?? []) },
    };
  }
}

/** The document minus what only the projection cares about. */
function toHit(doc: ProductDocument): SearchHitDto {
  return {
    id: doc.id,
    sku: doc.sku,
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    priceMinor: doc.priceMinor,
    currency: doc.currency,
    exponent: doc.exponent,
    categorySlug: doc.categorySlug,
    categoryName: doc.categoryName,
    weightGrams: doc.weightGrams,
    version: doc.version,
    updatedAt: doc.updatedAt,
  };
}

function toFacets(buckets: Bucket[]): CategoryFacetDto[] {
  return buckets.map((bucket) => ({
    slug: bucket.key,
    name: bucket[FACET_NAME_AGG]?.buckets[0]?.key ?? bucket.key,
    count: bucket.doc_count,
  }));
}
