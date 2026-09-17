/**
 * The projection: one pure function from a `product.*` event payload to the
 * document the `products` index stores.
 *
 * It is deliberately boring. Everything the document needs is on the event —
 * full state, not a diff, so a document is written from one message without
 * a join or a lookup — and the only work here is deciding what to do with a
 * missing category and where the exponent comes from.
 */

/** What catalog puts on `product.created` / `product.updated`. */
export interface ProductEventPayload {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  weightGrams: number;
  active: boolean;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  categoryVersion: number | null;
  version: number;
  updatedAt: string | Date;
}

/** One document in the `products` index. The mapping in products.index.ts is this shape. */
export interface ProductDocument {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  exponent: number;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  categoryVersion: number | null;
  active: boolean;
  weightGrams: number;
  version: number;
  updatedAt: string;
}

/**
 * Catalog prices are in the base currency, and the base currency is a
 * two-decimal one. The event carries no exponent because catalog has no
 * `currencies` table — pricing-service owns that (M11) — and the index does
 * not convert (ADR-0010), so this is a property of the catalog, not a lookup.
 * If the base currency ever changes, this is the one line to change.
 */
export const BASE_CURRENCY_EXPONENT = 2;

export function toProductDocument(payload: ProductEventPayload): ProductDocument {
  return {
    id: payload.id,
    sku: payload.sku,
    slug: payload.slug,
    name: payload.name,
    description: payload.description ?? null,
    priceMinor: payload.priceMinor,
    currency: payload.currency,
    exponent: BASE_CURRENCY_EXPONENT,
    // A product with no category is indexed, not skipped: it is still
    // searchable by name, it just has no facet. Null, not "", so the facet
    // aggregation leaves it out rather than counting an empty bucket.
    categoryId: payload.categoryId ?? null,
    categorySlug: payload.categorySlug ?? null,
    categoryName: payload.categoryName ?? null,
    categoryVersion: payload.categoryVersion ?? null,
    active: payload.active,
    weightGrams: payload.weightGrams,
    version: payload.version,
    updatedAt:
      payload.updatedAt instanceof Date ? payload.updatedAt.toISOString() : payload.updatedAt,
  };
}

/** True when the payload has what the index and its version guard need. */
export function isProductEventPayload(value: unknown): value is ProductEventPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.version === 'number' &&
    Number.isInteger(p.version) &&
    p.version > 0 &&
    typeof p.sku === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.name === 'string' &&
    typeof p.priceMinor === 'number' &&
    typeof p.currency === 'string' &&
    typeof p.active === 'boolean'
  );
}
