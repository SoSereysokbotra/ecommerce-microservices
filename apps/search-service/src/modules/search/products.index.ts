/**
 * The `products` index: one document per product, written only by consuming
 * catalog's `product.*` events (step 3) and read by `GET /search/products`
 * (step 4).
 *
 * The mapping is fixed here, at the scaffold, because changing a field's type
 * later means dropping the index and reindexing — which the write-side
 * republish (step 5) makes possible but not free. The field list is the
 * document in docs/M12_SEARCH_PLAN.md §6 and nothing more.
 */
export const PRODUCTS_INDEX = 'products';

export const PRODUCTS_INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    // Single node: a replica shard could never be allocated, and an
    // unallocated replica leaves the cluster permanently yellow — which would
    // make the healthcheck and /ready unable to tell "degraded" from "normal".
    number_of_replicas: 0,
  },
  mappings: {
    // An event field the mapping does not know about fails the write instead
    // of silently creating a field with a guessed type. The projection in
    // step 3 maps events to documents explicitly, so nothing legitimate is
    // dynamic.
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      sku: { type: 'keyword' },
      slug: { type: 'keyword' },
      // Full-text for the query; the keyword sub-field is for exact match and
      // for sorting, which `text` cannot do.
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      description: { type: 'text' },
      // The catalog's base-currency price, never converted. Listings do not
      // convert (ADR-0010); the cart is where the number becomes binding.
      priceMinor: { type: 'integer' },
      currency: { type: 'keyword' },
      exponent: { type: 'integer' },
      categoryId: { type: 'keyword' },
      // The facet. Denormalised onto every product, which is why a category
      // rename has to fan out (step 6) and why `categoryVersion` is here.
      categorySlug: { type: 'keyword' },
      categoryName: { type: 'keyword' },
      categoryVersion: { type: 'integer' },
      active: { type: 'boolean' },
      weightGrams: { type: 'integer' },
      // Also the external versioning key on every write — the stored copy
      // is what a search result reports; the `_version` OpenSearch tracks is
      // what rejects a stale write.
      version: { type: 'long' },
      updatedAt: { type: 'date' },
    },
  },
} as const;
