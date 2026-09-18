import { Sort } from './dto/search-products.dto';

/**
 * From the request to the OpenSearch body — a pure function, so the shape of
 * every query is unit-testable without a cluster.
 *
 * ## Where each filter goes, and why it matters
 *
 * `query`        active + text + price. Everything the *facet counts* are
 *                computed over.
 * `post_filter`  the category. Applied to the hits **after** aggregation, so
 *                the category facet still lists every category that matches
 *                the text and price — with the count you would get by
 *                clicking it — rather than collapsing to the one selected.
 *                Put the category in `query` and the facet would show a
 *                single row the moment anyone used it.
 *
 * `active: true` is a `filter`, never a `must`: it contributes nothing to the
 * score and is cached. It is also unconditional — there is no way to ask this
 * endpoint for an inactive product, which is the read side's half of "catalog
 * does not delete, it deactivates".
 */
export interface SearchQueryInput {
  q?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort: Sort;
  page: number;
  limit: number;
}

export const FACET_AGG = 'categories';
export const FACET_NAME_AGG = 'name';
export const FACET_SIZE = 50;

export function buildSearchBody(input: SearchQueryInput): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [{ term: { active: true } }];

  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    const range: Record<string, number> = {};
    if (input.minPrice !== undefined) range.gte = input.minPrice;
    if (input.maxPrice !== undefined) range.lte = input.maxPrice;
    filter.push({ range: { priceMinor: range } });
  }

  const text = input.q?.trim();
  const must: Record<string, unknown>[] = text
    ? [
        {
          multi_match: {
            query: text,
            // A hit in the name outranks the same words in a description.
            fields: ['name^3', 'description'],
            // Typos are the whole point of search over `LIKE` — but not on
            // short words. Plain AUTO allows one edit from three letters up,
            // and live that made "tee" match "Ten vinyl stickers". AUTO:4,7
            // is exact below four letters, one edit to six, two from seven.
            fuzziness: 'AUTO:4,7',
            operator: 'and',
          },
        },
      ]
    : [];

  const body: Record<string, unknown> = {
    from: (input.page - 1) * input.limit,
    size: input.limit,
    track_total_hits: true,
    query: { bool: { must, filter } },
    aggs: {
      [FACET_AGG]: {
        terms: { field: 'categorySlug', size: FACET_SIZE },
        // The display name, from the documents themselves. All products in a
        // category carry the same name except during a rename's fan-out
        // (step 6), when the most common one wins for a second.
        aggs: { [FACET_NAME_AGG]: { terms: { field: 'categoryName', size: 1 } } },
      },
    },
  };

  if (input.category) {
    body.post_filter = { term: { categorySlug: input.category } };
  }

  if (input.sort === 'price_asc') {
    body.sort = [{ priceMinor: 'asc' }, { 'name.keyword': 'asc' }];
  } else if (input.sort === 'price_desc') {
    body.sort = [{ priceMinor: 'desc' }, { 'name.keyword': 'asc' }];
  } else if (!text) {
    // Relevance with nothing to be relevant to is a constant score; give the
    // browse page a stable order instead of index order.
    body.sort = [{ 'name.keyword': 'asc' }];
  }

  return body;
}
