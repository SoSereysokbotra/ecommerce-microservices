import { Client } from '@opensearch-project/opensearch';
import { OpenSearchClient } from '../src/modules/search/opensearch.client';
import { FACET_AGG, SearchQueryInput, buildSearchBody } from '../src/modules/search/search-query';
import { SearchService } from '../src/modules/search/search.service';

/**
 * The query, without a cluster.
 *
 * What is asserted is the shape docs/M12_SEARCH_PLAN.md §6 promises: only
 * active products, ever; the category in `post_filter` so the facet is
 * computed over the text-and-price set rather than collapsing to the chosen
 * category; and the sorts.
 */
const base: SearchQueryInput = { sort: 'relevance', page: 1, limit: 20 };

type BoolQuery = { bool: { must: unknown[]; filter: unknown[] } };

function boolOf(body: Record<string, unknown>): BoolQuery['bool'] {
  return (body.query as BoolQuery).bool;
}

describe('buildSearchBody', () => {
  it('always filters to active products, even with no other input', () => {
    const body = buildSearchBody(base);
    expect(boolOf(body).filter).toEqual([{ term: { active: true } }]);
    expect(boolOf(body).must).toEqual([]);
    expect(body.post_filter).toBeUndefined();
  });

  it('searches name (boosted) and description for q', () => {
    const body = buildSearchBody({ ...base, q: '  tee ' });
    expect(boolOf(body).must).toEqual([
      expect.objectContaining({
        multi_match: expect.objectContaining({ query: 'tee', fields: ['name^3', 'description'] }),
      }),
    ]);
    // Relevance order: no explicit sort.
    expect(body.sort).toBeUndefined();
  });

  it('is exact on short words — "tee" must not match "ten"', () => {
    const body = buildSearchBody({ ...base, q: 'tee' });
    const [clause] = boolOf(body).must as { multi_match: { fuzziness: string } }[];
    expect(clause.multi_match.fuzziness).toBe('AUTO:4,7');
  });

  it('puts the category in post_filter, not the query, so facet counts survive it', () => {
    const body = buildSearchBody({ ...base, category: 'apparel' });
    expect(body.post_filter).toEqual({ term: { categorySlug: 'apparel' } });
    expect(JSON.stringify(body.query)).not.toContain('apparel');
  });

  it('turns min/max price into one inclusive range filter', () => {
    const body = buildSearchBody({ ...base, minPrice: 1000, maxPrice: 5000 });
    expect(boolOf(body).filter).toContainEqual({ range: { priceMinor: { gte: 1000, lte: 5000 } } });
  });

  it('accepts an open-ended range', () => {
    expect(boolOf(buildSearchBody({ ...base, minPrice: 1000 })).filter).toContainEqual({
      range: { priceMinor: { gte: 1000 } },
    });
    expect(boolOf(buildSearchBody({ ...base, maxPrice: 5000 })).filter).toContainEqual({
      range: { priceMinor: { lte: 5000 } },
    });
  });

  it('sorts by price with a stable tiebreak', () => {
    expect(buildSearchBody({ ...base, sort: 'price_asc' }).sort).toEqual([
      { priceMinor: 'asc' },
      { 'name.keyword': 'asc' },
    ]);
    expect(buildSearchBody({ ...base, sort: 'price_desc' }).sort).toEqual([
      { priceMinor: 'desc' },
      { 'name.keyword': 'asc' },
    ]);
  });

  it('gives a browse (no q) a stable name order instead of index order', () => {
    expect(buildSearchBody(base).sort).toEqual([{ 'name.keyword': 'asc' }]);
  });

  it('pages with from/size', () => {
    const body = buildSearchBody({ ...base, page: 3, limit: 10 });
    expect(body.from).toBe(20);
    expect(body.size).toBe(10);
  });

  it('always asks for the category facet', () => {
    const aggs = buildSearchBody(base).aggs as Record<string, unknown>;
    expect(aggs[FACET_AGG]).toMatchObject({ terms: { field: 'categorySlug' } });
  });
});

describe('SearchService.products', () => {
  function serviceWith(search: jest.Mock): SearchService {
    const client = { search } as unknown as Client;
    return new SearchService(new OpenSearchClient(client));
  }

  it('shapes hits, total and facets from the cluster response', async () => {
    const service = serviceWith(
      jest.fn(async () => ({
        body: {
          hits: {
            total: { value: 2 },
            hits: [
              {
                _source: {
                  id: 'p-1',
                  sku: 'TEE',
                  slug: 'tee',
                  name: 'Tee',
                  description: null,
                  priceMinor: 1999,
                  currency: 'USD',
                  exponent: 2,
                  categoryId: 'c-1',
                  categorySlug: 'apparel',
                  categoryName: 'Apparel',
                  categoryVersion: 1,
                  active: true,
                  weightGrams: 180,
                  version: 3,
                  updatedAt: '2026-09-17T10:00:00.000Z',
                },
              },
            ],
          },
          aggregations: {
            [FACET_AGG]: {
              buckets: [
                { key: 'apparel', doc_count: 2, name: { buckets: [{ key: 'Apparel' }] } },
                { key: 'mystery', doc_count: 1, name: { buckets: [] } },
              ],
            },
          },
        },
      })),
    );

    const result = await service.products({ ...base, q: 'tee' });

    expect(result.total).toBe(2);
    expect(result.hits).toHaveLength(1);
    // The projection's bookkeeping fields stay out of the API.
    expect(result.hits[0]).not.toHaveProperty('categoryId');
    expect(result.hits[0]).not.toHaveProperty('active');
    expect(result.hits[0]).toMatchObject({ id: 'p-1', priceMinor: 1999, exponent: 2 });
    expect(result.facets.categories).toEqual([
      { slug: 'apparel', name: 'Apparel', count: 2 },
      // No name bucket: fall back to the slug rather than crash or blank.
      { slug: 'mystery', name: 'mystery', count: 1 },
    ]);
  });

  it('turns an unreachable cluster into a 503', async () => {
    const service = serviceWith(
      jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(service.products(base)).rejects.toMatchObject({ status: 503 });
  });
});
