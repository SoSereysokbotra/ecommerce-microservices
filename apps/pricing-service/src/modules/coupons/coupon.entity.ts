import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { DiscountEntity } from '../pricing/discount.entity';

/**
 * A discount that has to be asked for by name.
 *
 * The money part is not here — it is the `DiscountEntity` this points at, which
 * M8 already knows how to apply and allocate to the penny. A coupon adds the
 * three things a code needs and an automatic promotion does not: a **limit**, a
 * **window**, and a record of **who has used it**.
 *
 * M8 left `discounts.code` present and always NULL precisely to mark this
 * boundary. The test for which milestone something belongs to was "does
 * applying it write anything down"; a coupon does, and that writing is the
 * whole difficulty.
 */
@Entity({ name: 'coupons' })
export class CouponEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Stored upper-cased and compared exactly.
   *
   * Customers type `save10`; marketing prints `SAVE10`. Case-insensitive
   * matching via `citext` would work too, but it pulls a Postgres extension in
   * for one column — normalising on write is cheaper and leaves the index a
   * plain unique btree.
   */
  @Column({ unique: true })
  code: string;

  @Column({ name: 'discount_id', type: 'uuid' })
  discountId: string;

  @ManyToOne(() => DiscountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'discount_id' })
  discount: DiscountEntity;

  /** Null means unlimited. A number means exactly that many, ever. */
  @Column({ name: 'max_uses', type: 'integer', nullable: true })
  maxUses: number | null;

  /**
   * Held **or** committed redemptions — what a shopper should be told is gone.
   *
   * Never incremented by a read-modify-write. See `CouponsService.hold()`: the
   * check and the increment happen in one statement that cannot be interleaved,
   * which is the entire point of this milestone.
   */
  @Column({ name: 'used_count', type: 'integer', default: 0 })
  usedCount: number;

  /** Null means no per-customer cap. */
  @Column({ name: 'per_customer_limit', type: 'integer', nullable: true })
  perCustomerLimit: number | null;

  @Column({ name: 'starts_at', type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ name: 'ends_at', type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /**
   * Optimistic locking for **edits to the coupon**, not for redemption.
   *
   * `IMPLEMENTATION_PLAN.md` proposed version-checked redemption; ADR-0008
   * explains why redemption uses an atomic conditional UPDATE instead. Version
   * still earns its place here: two admins changing `max_uses` at once is a
   * rare conflict where the loser should be told rather than silently retried,
   * which is exactly what optimistic locking is good at.
   */
  @VersionColumn()
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
