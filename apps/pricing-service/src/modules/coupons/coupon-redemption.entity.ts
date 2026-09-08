import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CouponEntity } from './coupon.entity';

/**
 * One order's claim on a coupon.
 *
 * The lifecycle is deliberately the same as an inventory reservation, because
 * the problem is the same: a finite resource claimed while an order is still
 * only a possibility.
 *
 *   inventory:  available -> reserved -> committed   (or released / expired)
 *   coupon:                  HELD     -> COMMITTED   (or RELEASED)
 *
 * Reusing the shape means the saga's existing compensation fires at exactly the
 * right moments, and anyone who has read inventory already knows how this works.
 */
export enum RedemptionStatus {
  /** The order exists but is not paid. The use is claimed, not spent. */
  HELD = 'held',
  /** The order was confirmed. The use is spent for good. */
  COMMITTED = 'committed',
  /** The order was cancelled. The use went back. */
  RELEASED = 'released',
}

@Entity({ name: 'coupon_redemptions' })
export class CouponRedemptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'coupon_id', type: 'uuid' })
  couponId: string;

  @ManyToOne(() => CouponEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coupon_id' })
  coupon: CouponEntity;

  /**
   * **Unique.** One redemption per order, ever.
   *
   * This is what makes holding a coupon idempotent on an at-least-once bus: a
   * redelivered `order.created` cannot claim a second use, because the second
   * insert violates this index rather than quietly incrementing the counter.
   * The same guard inventory gets from its `(order_id, product_id)` index.
   *
   * A released row keeps its `order_id`, so a cancelled order cannot re-claim
   * the coupon by retrying — the customer places a *new* order, with a new id.
   */
  @Column({ name: 'order_id', type: 'uuid', unique: true })
  orderId: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'enum', enum: RedemptionStatus, default: RedemptionStatus.HELD })
  status: RedemptionStatus;

  /**
   * What the coupon actually took off this order, frozen at hold time.
   *
   * Stored rather than recomputed for the same reason M8 freezes the whole
   * quote onto the order: changing the coupon tomorrow must not rewrite what a
   * customer was charged today.
   */
  @Column({ name: 'amount_minor', type: 'integer', default: 0 })
  amountMinor: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
