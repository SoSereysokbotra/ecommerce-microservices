import type { RequestParams } from '@opensearch-project/opensearch';
import { PRODUCTS_INDEX } from './products.index';

/** What catalog puts on `category.created` / `category.updated`. */
export interface CategoryEventPayload {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  updatedAt: string | Date;
}

export function isCategoryEventPayload(value: unknown): value is CategoryEventPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.name === 'string' &&
    typeof p.version === 'number' &&
    Number.isInteger(p.version) &&
    p.version > 0
  );
}

/**
 * The denormalisation bill, paid: one `_update_by_query` that rewrites the
 * category fields on every product in the category.
 *
 * ## The guard is the query
 *
 * `categoryVersion < event.version` is in the *filter*, so a stale rename —
 * an older event arriving after a newer one has already fanned out — matches
 * **no documents** and is a no-op by construction. The same rule the product
 * upsert gets from `version_type: external`, expressed as a range because
 * `_update_by_query` has no external versioning of its own.
 *
 * ## What it deliberately leaves alone
 *
 * The product's own `version`. That is the *product's* version and belongs to
 * `product.updated`; this write changes only what the category contributed.
 * A later `product.updated` carries the current category name anyway, and
 * its higher product version lands over whatever this wrote.
 *
 * `conflicts: 'proceed'` — if a product document is being rewritten by its
 * own event at the same instant, skip it rather than abort the batch; that
 * product event carries the current category name itself.
 */
export function buildCategoryFanout(category: CategoryEventPayload): RequestParams.UpdateByQuery {
  return {
    index: PRODUCTS_INDEX,
    conflicts: 'proceed',
    refresh: true,
    body: {
      query: {
        bool: {
          filter: [
            { term: { categoryId: category.id } },
            { range: { categoryVersion: { lt: category.version } } },
          ],
        },
      },
      script: {
        lang: 'painless',
        source:
          'ctx._source.categorySlug = params.slug; ' +
          'ctx._source.categoryName = params.name; ' +
          'ctx._source.categoryVersion = params.version;',
        params: { slug: category.slug, name: category.name, version: category.version },
      },
    },
  };
}
