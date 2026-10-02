import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum ReviewStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/**
 * A review. Written by a request — unlike search-service's documents, this is
 * state, which is why reviews-service has a database at all.
 *
 * **Only `approved` reviews are public or counted.** A new review is
 * `pending`; an edit sends it back to `pending`, because an edit is a new
 * submission. The rollup in `product_ratings` moves only on a status
 * transition, never on creation.
 */
@Entity({ name: 'reviews' })
// One review per customer per product. A second is an edit, not a new row —
// the API answers 409 and points at PATCH.
@Unique('UQ_reviews_product_customer', ['productId', 'customerId'])
// The public read: approved reviews for a product, newest first.
@Index('IDX_reviews_product_status', ['productId', 'status'])
// The moderation queue: everything pending, oldest first.
@Index('IDX_reviews_status_created', ['status', 'createdAt'])
export class ReviewEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  /**
   * The purchase this review was written against. Kept for provenance — which
   * order earned the right — not to enforce anything; the eligibility check
   * reads `purchases`.
   */
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  /** 1–5, integer. No halves: a half star is a presentation choice. */
  @Column({ type: 'integer' })
  rating: number;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /**
   * Snapshotted from users-service when the review is created. A later name
   * change does not rewrite old reviews — the same reason `order_items` copies
   * the product name rather than looking it up.
   */
  @Column({ name: 'author_name' })
  authorName: string;

  @Column({ type: 'varchar', length: 16, default: ReviewStatus.PENDING })
  status: ReviewStatus;

  /** Who moderated it and why, when someone did. */
  @Column({ name: 'moderated_at', type: 'timestamptz', nullable: true })
  moderatedAt?: Date | null;

  @Column({ name: 'moderation_note', type: 'text', nullable: true })
  moderationNote?: string | null;

  /**
   * Bumped on every write. The guard is **not** this column by itself —
   * TypeORM's `@VersionColumn` increments on `save()` without checking, which
   * M12 step 1 proved with a collision test (HANDOFF §5). Transitions are
   * conditional UPDATEs on `status`, the saga's step guard applied to a much
   * smaller machine.
   */
  @Column({ type: 'integer', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
