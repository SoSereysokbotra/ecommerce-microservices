import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { extractCoPurchasePairs } from './co-purchase-pairs';
import { CatalogClient, CatalogProduct } from './catalog.client';
import { RecommendationsResponseDto, RecommendedProductDto } from './dto/recommendations.dto';

export const UPSERT_CO_PURCHASE_SQL = `INSERT INTO product_recommendations (product_id, recommended_product_id, co_purchase_count)
VALUES ($1, $2, 1)
ON CONFLICT (product_id, recommended_product_id)
DO UPDATE SET co_purchase_count = product_recommendations.co_purchase_count + 1,
              updated_at = now()`;

export const SELECT_RECOMMENDATIONS_SQL = `SELECT recommended_product_id, co_purchase_count
  FROM product_recommendations
 WHERE product_id = $1
 ORDER BY co_purchase_count DESC, recommended_product_id ASC
 LIMIT $2`;

/**
 * Recommendations service: maintains and serves the co-purchase graph.
 *
 * M14 plan §4: A co-purchase counter is an accumulator (`count = count + 1`),
 * unlike search-service's state projections which tolerate replay. Applying
 * the same order event twice corrupts the data permanently and silently.
 *
 * Therefore, all counter increments run inside the caller's transaction
 * alongside the `processed_events` marker (via IdempotencyService.handleOnce).
 *
 * Enriched hits (M14 plan §13 step 3 & §14 settled):
 * Recommendations reads catalog itself, returning complete product cards
 * rather than bare IDs.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalogClient: CatalogClient,
  ) {}

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

  /**
   * Reads the top co-purchased products for a given product and enriches them via catalog-service.
   *
   * Rules (M14 plan §13 step 3):
   * 1. Reads rows ordered by co_purchase_count DESC, with recommended_product_id ASC tiebreak.
   * 2. Fetches matching products from catalog in a single bulk request.
   * 3. Drops inactive products or products deleted from catalog.
   * 4. Returns empty `{ items: [], total: 0 }` for products with no co-purchases, not 404.
   *
   * @param productId Catalog product UUID
   * @param limit Maximum recommendations to return (default 4, max 20)
   * @param correlationId Distributed tracing ID
   */
  async getRecommendations(
    productId: string,
    limit = 4,
    correlationId?: string,
  ): Promise<RecommendationsResponseDto> {
    const take = Math.min(Math.max(limit, 1), 20);

    const rows: Array<{
      recommended_product_id: string;
      co_purchase_count: number | string;
    }> = await this.dataSource.query(SELECT_RECOMMENDATIONS_SQL, [productId, take]);

    if (!rows || rows.length === 0) {
      return { items: [], total: 0 };
    }

    const recommendedIds = rows.map((r) => r.recommended_product_id);
    const catalogProducts = await this.catalogClient.getProductsByIds(
      recommendedIds,
      correlationId,
    );

    const activeMap = new Map<string, CatalogProduct>();
    for (const p of catalogProducts) {
      if (p.active) {
        activeMap.set(p.id, p);
      }
    }

    const items: RecommendedProductDto[] = [];
    for (const row of rows) {
      const product = activeMap.get(row.recommended_product_id);
      if (product) {
        items.push({
          productId: product.id,
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          priceMinor: product.priceMinor,
          currency: product.currency,
          coPurchaseCount: Number(row.co_purchase_count),
        });
      }
    }

    return {
      items,
      total: items.length,
    };
  }

  /**
   * Reset the recommendations read model and idempotency tracking.
   *
   * Pairs with POST /orders/admin/replay-co-purchases (M14 plan §7, §13).
   * Truncating product_recommendations wipes accumulated counts so a replay
   * does not double them. Deleting recommendations-service markers from
   * processed_events ensures a replay can re-process cleanly if needed.
   */
  async reset(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query('TRUNCATE TABLE product_recommendations');
      await manager.query(
        "DELETE FROM processed_events WHERE consumer = 'recommendations-service'",
      );
    });
    this.logger.log('Reset product_recommendations and idempotency markers');
  }
}
