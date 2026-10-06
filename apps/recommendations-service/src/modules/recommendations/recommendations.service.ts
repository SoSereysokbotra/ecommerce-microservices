import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { extractCoPurchasePairs } from './co-purchase-pairs';

export const UPSERT_CO_PURCHASE_SQL = `INSERT INTO product_recommendations (product_id, recommended_product_id, co_purchase_count)
VALUES ($1, $2, 1)
ON CONFLICT (product_id, recommended_product_id)
DO UPDATE SET co_purchase_count = product_recommendations.co_purchase_count + 1,
              updated_at = now()`;

/**
 * Recommendations service: maintains the co-purchase graph.
 *
 * M14 plan §4: A co-purchase counter is an accumulator (`count = count + 1`),
 * unlike search-service's state projections which tolerate replay. Applying
 * the same order event twice corrupts the data permanently and silently.
 *
 * Therefore, all counter increments run inside the caller's transaction
 * alongside the `processed_events` marker (via IdempotencyService.handleOnce).
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  /**
   * Records symmetric co-purchase pairs for confirmed order items.
   *
   * Executes one statement per pair inside the caller's transaction:
   * never read-then-write, or two concurrent orders both read 5 and both write 6
   * (lost-update anomaly; same reasoning as M9's coupon claims).
   *
   * @param manager The transactional EntityManager provided by handleOnce
   * @param items The line items from order.confirmed
   * @returns Number of pairs incremented
   */
  async recordCoPurchases(
    manager: EntityManager,
    items: Array<{ productId: string }>,
  ): Promise<number> {
    const pairs = extractCoPurchasePairs(items);
    if (pairs.length === 0) {
      return 0;
    }

    for (const pair of pairs) {
      await manager.query(UPSERT_CO_PURCHASE_SQL, [pair.productId, pair.recommendedProductId]);
    }

    this.logger.debug(`Recorded ${pairs.length} co-purchase pair(s)`);
    return pairs.length;
  }
}
