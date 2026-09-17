import { Injectable, Logger } from '@nestjs/common';
import { errors } from '@opensearch-project/opensearch';
import { OpenSearchClient } from './opensearch.client';
import { ProductDocument } from './product-document';
import { PRODUCTS_INDEX } from './products.index';

export type UpsertOutcome = 'written' | 'stale';

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
}

function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof errors.ResponseError &&
    (error.statusCode === 409 || error.body?.error?.type === 'version_conflict_engine_exception')
  );
}
