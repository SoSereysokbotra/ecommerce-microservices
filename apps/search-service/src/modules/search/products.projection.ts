import { Injectable, Logger } from '@nestjs/common';
import { errors } from '@opensearch-project/opensearch';
import { OpenSearchClient } from './opensearch.client';
import { ProductDocument } from './product-document';
import { PRODUCTS_INDEX } from './products.index';
import { CategoryEventPayload, buildCategoryFanout } from './category-fanout';

export type UpsertOutcome = 'written' | 'stale';

export interface FanoutOutcome {
  matched: number;
  updated: number;
}

/**
 * The versioned write — the whole of M12's idempotency, in one call.
 *
 * `version_type: external` tells OpenSearch to accept the write only if the
 * given version is **greater** than the stored one. Three different failures
 * collapse into that single rule:
 *
 *   | Delivery                              | Stored | Incoming | Result   |
 *   |---------------------------------------|--------|----------|----------|
 *   | first time                            | —      | 7        | written  |
 *   | same event redelivered                | 7      | 7        | 409      |
 *   | republished under a new event id      | 7      | 7        | 409      |
 *   | **v6 arriving after v7**              | 7      | 6        | 409      |
 *
 * The last row is what a `processed_events` marker can never catch — it
 * knows "seen this event", not "seen a newer one" — and it is why this
 * service has no such table and no database. The store enforces the rule;
 * application code only has to not undo it, which means **treating 409 as
 * success**. A 409 that were rethrown would nack the message with
 * `requeue=false` and the bus would drop an event that was never wrong.
 */
@Injectable()
export class ProductsProjection {
  private readonly logger = new Logger(ProductsProjection.name);

  constructor(private readonly opensearch: OpenSearchClient) {}

  async upsert(doc: ProductDocument): Promise<UpsertOutcome> {
    try {
      await this.opensearch.raw.index({
        index: PRODUCTS_INDEX,
        id: doc.id,
        version: doc.version,
        version_type: 'external',
        body: doc,
        // Make the write visible to the next search immediately. The
        // acceptance test is "an edit appears within seconds"; the default
        // 1 s refresh would be fine, but the no-op proofs read straight
        // after writing and should not have to sleep.
        refresh: true,
      });
      return 'written';
    } catch (error) {
      if (isVersionConflict(error)) {
        this.logger.debug(`Product ${doc.id} v${doc.version} is stale or already indexed; ignored`);
        return 'stale';
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
