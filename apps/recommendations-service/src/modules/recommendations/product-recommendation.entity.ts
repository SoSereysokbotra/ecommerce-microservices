import { Check, Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Co-purchase relationship counter between two distinct products.
 *
 * Symmetric directed rows per M14 plan §6 (Alternative 2):
 * A confirmed order containing products A and B writes both (A, B) and (B, A).
 * Although this doubles the storage rows, it optimizes the read path to a single
 * index scan on (product_id, co_purchase_count DESC) without requiring OR scans
 * or CASE expressions.
 *
 * Check constraints enforce:
 * - A product is never paired with itself (product_id <> recommended_product_id)
 * - Co-purchase counter is non-negative (co_purchase_count >= 0)
 */
@Entity({ name: 'product_recommendations' })
@Index('IDX_product_recommendations_lookup', ['productId', 'coPurchaseCount'])
@Check('CHK_product_recommendations_distinct', '"product_id" <> "recommended_product_id"')
@Check('CHK_product_recommendations_count_nonneg', '"co_purchase_count" >= 0')
export class ProductRecommendationEntity {
  /** The source product being queried. */
  @PrimaryColumn({ name: 'product_id', type: 'uuid' })
  productId: string;

  /** The recommended co-purchased product. */
  @PrimaryColumn({ name: 'recommended_product_id', type: 'uuid' })
  recommendedProductId: string;

  /** Number of times these two products have been purchased in the same confirmed order. */
  @Column({ name: 'co_purchase_count', type: 'integer', default: 0 })
  coPurchaseCount: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
