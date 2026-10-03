import { Injectable, Logger } from '@nestjs/common';
import { errors } from '@opensearch-project/opensearch';
import { OpenSearchClient } from './opensearch.client';
import { ProductDocument } from './product-document';
import { PRODUCTS_INDEX } from './products.index';
import { CategoryEventPayload, buildCategoryFanout } from './category-fanout';

export type UpsertOutcome = 'written' | 'noop';

export interface FanoutOutcome {
  matched: number;
  updated: number;
}

/**
 * Payload for `product.rating_changed` emitted by reviews-service (M13).
 */
export interface RatingEventPayload {
  productId: string;
  ratingSum?: number;
  ratingCount: number;
  ratingAvgE2: number;
  version: number;
}

/**
 * True when the payload has what the rating rollup projection needs.
 */
export function isRatingEventPayload(value: unknown): value is RatingEventPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.productId === 'string' &&
    p.productId.length > 0 &&
    typeof p.version === 'number' &&
    Number.isInteger(p.version) &&
    p.version > 0 &&
    typeof p.ratingAvgE2 === 'number' &&
    Number.isInteger(p.ratingAvgE2) &&
    typeof p.ratingCount === 'number' &&
    Number.isInteger(p.ratingCount) &&
    p.ratingCount >= 0
  );
}

/**
 * Product upsert script (docs/M13_REVIEWS_PLAN.md §5 Option A).
 *
 * Replaces the previous `index()` with `version_type: external` (ADR-0011)
 * because a whole-document index replaces the document and wipes rating fields.
 *
 * Painless script rules:
 * 1. Checks its own clock (`version`). If `ctx._source.version >= params.version`,
 *    sets `ctx.op = 'none'` (a no-op).
 * 2. On upsert (absent document), `ctx._source` starts empty, so `ctx._source.version`
 *    is null — guarded with `!= null`.
 * 3. Sets every product field, leaving all rating* fields untouched.
 * 4. Must NOT mention rating fields.
 */
export const PRODUCT_UPSERT_SCRIPT = `
if (ctx._source.version != null && ctx._source.version >= params.version) {
  ctx.op = 'none';
} else {
  ctx._source.id = params.id;
  ctx._source.sku = params.sku;
  ctx._source.slug = params.slug;
  ctx._source.name = params.name;
  ctx._source.description = params.description;
  ctx._source.priceMinor = params.priceMinor;
  ctx._source.currency = params.currency;
  ctx._source.exponent = params.exponent;
  ctx._source.categoryId = params.categoryId;
  ctx._source.categorySlug = params.categorySlug;
  ctx._source.categoryName = params.categoryName;
  ctx._source.categoryVersion = params.categoryVersion;
  ctx._source.active = params.active;
  ctx._source.weightGrams = params.weightGrams;
  ctx._source.version = params.version;
  ctx._source.updatedAt = params.updatedAt;
}
`.trim();

/**
 * Rating upsert script (docs/M13_REVIEWS_PLAN.md §5 Option A).
 *
 * Each write side owns disjoint fields of the read-model document with its
 * own clock. Ratings are guarded by `ratingVersion`.
 *
 * Painless script rules:
 * 1. Checks its own clock (`ratingVersion`). If `ctx._source.ratingVersion >= params.version`,
 *    sets `ctx.op = 'none'` (a no-op).
 * 2. On upsert, `ctx._source.ratingVersion` is null — guarded with `!= null`.
 * 3. Sets ratingAvgE2, ratingCount, ratingVersion, leaving all product fields untouched.
 * 4. Must NOT mention product fields.
 */
export const RATING_UPSERT_SCRIPT = `
if (ctx._source.ratingVersion != null && ctx._source.ratingVersion >= params.version) {
  ctx.op = 'none';
} else {
  ctx._source.ratingAvgE2 = params.ratingAvgE2;
  ctx._source.ratingCount = params.ratingCount;
  ctx._source.ratingVersion = params.version;
}
`.trim();

/**
 * The versioned projection — two write sides projecting onto one document (M13).
 *
 * Catalog owns product fields under `version`.
 * Reviews owns rating fields under `ratingVersion`.
 *
 * Both use scripted `update()` with `scripted_upsert: true` and `retry_on_conflict: 3`.
 * When a stale or duplicate event arrives, `ctx.op = 'none'` causes OpenSearch to
 * return `{ result: 'noop' }`, which is treated as success (result: 'noop' is the new 'stale').
 */
@Injectable()
export class ProductsProjection {
  private readonly logger = new Logger(ProductsProjection.name);

  constructor(private readonly opensearch: OpenSearchClient) {}

  async upsert(doc: ProductDocument): Promise<UpsertOutcome> {
    try {
      const response = await this.opensearch.raw.update({
        index: PRODUCTS_INDEX,
        id: doc.id,
        retry_on_conflict: 3,
        refresh: true,
        body: {
          script: {
            lang: 'painless',
            source: PRODUCT_UPSERT_SCRIPT,
            params: { ...doc },
          },
          upsert: {},
          scripted_upsert: true,
        },
      });
      const result = (response.body as { result?: string })?.result;
      if (result === 'noop') {
        this.logger.debug(`Product ${doc.id} v${doc.version} is stale or already indexed; ignored`);
        return 'noop';
      }
      return 'written';
    } catch (error) {
      if (isVersionConflict(error)) {
        this.logger.debug(`Product ${doc.id} v${doc.version} is stale or already indexed; ignored`);
        return 'noop';
      }
      throw error;
    }
  }

  /**
   * Apply rating rollup fields from reviews-service (`product.rating_changed`).
   * Guarded by `ratingVersion` — leaves all catalog product fields untouched.
   */
  async applyRating(payload: RatingEventPayload): Promise<UpsertOutcome> {
    try {
      const response = await this.opensearch.raw.update({
        index: PRODUCTS_INDEX,
        id: payload.productId,
        retry_on_conflict: 3,
        refresh: true,
        body: {
          script: {
            lang: 'painless',
            source: RATING_UPSERT_SCRIPT,
            params: {
              ratingAvgE2: payload.ratingAvgE2,
              ratingCount: payload.ratingCount,
              version: payload.version,
            },
          },
          upsert: {},
          scripted_upsert: true,
        },
      });
      const result = (response.body as { result?: string })?.result;
      if (result === 'noop') {
        this.logger.debug(
          `Product ${payload.productId} rating v${payload.version} is stale or already applied; ignored`,
        );
        return 'noop';
      }
      return 'written';
    } catch (error) {
      if (isVersionConflict(error)) {
        this.logger.debug(
          `Product ${payload.productId} rating v${payload.version} is stale or already applied; ignored`,
        );
        return 'noop';
      }
      throw error;
    }
  }

  /**
   * A category changed: rewrite its fields on every product that carries an
   * older `categoryVersion`. Zero matched means the rename was stale (or had
   * already fanned out) — a no-op, never an error. See `category-fanout.ts`.
   */
  async fanoutCategory(category: CategoryEventPayload): Promise<FanoutOutcome> {
    const response = await this.opensearch.raw.updateByQuery(buildCategoryFanout(category));
    const body = response.body as { total?: number; updated?: number };
    const outcome = { matched: body.total ?? 0, updated: body.updated ?? 0 };
    if (outcome.matched === 0) {
      this.logger.debug(`Category ${category.id} v${category.version} is stale or already applied`);
    }
    return outcome;
  }
}

function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof errors.ResponseError &&
    (error.statusCode === 409 || error.body?.error?.type === 'version_conflict_engine_exception')
  );
}
