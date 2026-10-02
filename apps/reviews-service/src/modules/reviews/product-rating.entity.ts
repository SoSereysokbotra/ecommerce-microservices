import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The rollup, and the source of truth for a product's average.
 *
 * search-service cannot compute this — it has no database and can only apply
 * what it is told — so the write side keeps it, updated **in the same
 * transaction** as the moderation decision that changed it, and announces the
 * whole row as `product.rating_changed`. See docs/M13_REVIEWS_PLAN.md §4.
 *
 * **Sum and count, never an average.** The average is derived at emit time in
 * BigInt and carried as an integer hundredth (437 = 4.37). ADR-0010's rule —
 * no float ever stored, ever compared — is not about money specifically; it is
 * about numbers people compare. A stored `4.37` would drift the moment it was
 * recomputed from a different direction.
 */
@Entity({ name: 'product_ratings' })
export class ProductRatingEntity {
  /** The catalog product id. One row per product, created on first approval. */
  @PrimaryColumn({ name: 'product_id', type: 'uuid' })
  productId: string;

  /** Sum of the ratings of every **approved** review. */
  @Column({ name: 'rating_sum', type: 'integer', default: 0 })
  ratingSum: number;

  /** How many approved reviews. Zero means "no rating", not "rated zero". */
  @Column({ name: 'rating_count', type: 'integer', default: 0 })
  ratingCount: number;

  /**
   * This row's own clock — a **third** version on the search document, beside
   * the product's and the category's. It is what lets the projection refuse a
   * stale rating without knowing anything about products.
   */
  @Column({ type: 'integer', default: 0 })
  version: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
