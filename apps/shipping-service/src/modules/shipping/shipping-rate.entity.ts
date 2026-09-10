import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ShippingZoneEntity } from './shipping-zone.entity';

/**
 * One price, for one service level, in one zone, for one weight band.
 *
 * ## The bands are half-open: `[min_weight_g, max_weight_g)`
 *
 * A parcel weighing **exactly** `max_weight_g` belongs to the *next* band up.
 * Closed ranges (`min <= w <= max`) leave a gap wherever one band's max is not
 * exactly one gram below the next band's min, and a basket landing in the gap
 * gets no rate at all — a 404 on a perfectly valid checkout, for a boundary
 * nobody tests by accident. Half-open ranges tile the number line with no gap
 * and no overlap, and the boundary case is the one the unit tests pin down.
 *
 * `max_weight_g IS NULL` is the top band, which every zone must have, or a
 * heavy enough basket falls off the end of the list.
 */
@Entity({ name: 'shipping_rates' })
export class ShippingRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'zone_id', type: 'uuid' })
  zoneId: string;

  @ManyToOne(() => ShippingZoneEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'zone_id' })
  zone?: ShippingZoneEntity;

  /** Service level: 'standard' | 'express'. Stable, and what an order freezes. */
  @Column({ type: 'varchar' })
  code: string;

  /** What the customer reads: 'Standard (3–5 days)'. */
  @Column({ type: 'varchar' })
  name: string;

  /** Inclusive lower bound, in grams. */
  @Column({ name: 'min_weight_g', type: 'integer', default: 0 })
  minWeightG: number;

  /** **Exclusive** upper bound. Null is the top band — see the class note. */
  @Column({ name: 'max_weight_g', type: 'integer', nullable: true })
  maxWeightG: number | null;

  /** Integer minor units, like every other amount in this project. */
  @Column({ name: 'price_minor', type: 'integer' })
  priceMinor: number;

  /**
   * Ship free when the basket reaches this, or null for never.
   *
   * Compared against the **discounted** subtotal — what the customer is
   * actually spending, not the sticker total before promotions. The other
   * reading ("spend $50 before discounts") rewards a shopper for a coupon they
   * did not use, and every threshold a shop advertises is the amount charged.
   * ADR-0009 records this because "free over $50" is ambiguous to everyone,
   * including whoever writes the next seed.
   *
   * Denominated in this rate's own `currency` column — unlike pricing's two
   * thresholds, which carry no currency at all. M11's audit
   * (docs/M11_CURRENCY_PLAN.md §3) lists all three together.
   *
   * A free rate is a `price_minor` of 0 on the quote, not a discount. Keeping it
   * out of `discountMinor` leaves that field meaning exactly one thing:
   * promotions and coupons against the goods.
   */
  @Column({ name: 'free_over_minor', type: 'integer', nullable: true })
  freeOverMinor: number | null;

  /** Nothing is multi-currency until M11; a mismatch here is a seeding error. */
  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
