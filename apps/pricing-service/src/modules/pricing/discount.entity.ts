import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED = 'fixed',
}

export enum DiscountScope {
  ORDER = 'order',
  CATEGORY = 'category',
  PRODUCT = 'product',
}

/**
 * An automatic promotion: it applies because the basket matches, with no code
 * to type and nothing written down when it does.
 *
 * That last part is the whole M8/M9 boundary. Applying one of these changes no
 * state, so a quote can be recomputed as often as anyone likes. **Coupons are
 * M9** — a code, a usage limit, optimistic locking, a redemption row per order,
 * and release when a saga compensates. The test for which milestone something
 * belongs to is exactly "does applying it write anything down".
 */
@Entity({ name: 'discounts' })
export class DiscountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Always NULL in M8, and present so the boundary above is visible in the
   * schema rather than only in a document. M9 fills it in and adds the
   * uniqueness, redemption and locking that a real code needs.
   */
  @Column({ type: 'varchar', nullable: true })
  code: string | null;

  /** Also the natural key the seed matches on, so re-seeding updates. */
  @Column({ unique: true })
  name: string;

  @Column({ type: 'enum', enum: DiscountType })
  type: DiscountType;

  /** Basis points, for `percentage`. Null for a fixed discount. */
  @Column({ name: 'value_bp', type: 'integer', nullable: true })
  valueBp: number | null;

  /** Minor units, for `fixed`. Null for a percentage discount. */
  /**
   * A fixed amount off — "$5 off" — in the **store's base currency**.
   *
   * M11's audit (docs/M11_CURRENCY_PLAN.md §3) found this is one of only three
   * money columns in the project with no currency anywhere near it, and all
   * three are in this service. That is not a coincidence: they were written
   * when there was one currency. Recorded here rather than left implicit,
   * because a quote in another currency has to convert it.
   */
  @Column({ name: 'value_minor', type: 'integer', nullable: true })
  valueMinor: number | null;

  @Column({ type: 'enum', enum: DiscountScope, default: DiscountScope.ORDER })
  scope: DiscountScope;

  /** Category slug or product id, depending on `scope`. Null for `order`. */
  @Column({ name: 'scope_ref', type: 'varchar', nullable: true })
  scopeRef: string | null;

  /**
   * Checked against the basket's original subtotal, not what an earlier
   * promotion left of it: "$5 off orders over $50" is a claim about the basket.
   */
  /**
   * The threshold a basket must reach — "spend $50" — in the **store's base
   * currency**. See `valueMinor` above; same audit, same reason.
   */
  @Column({ name: 'min_subtotal_minor', type: 'integer', default: 0 })
  minSubtotalMinor: number;

  @Column({ name: 'starts_at', type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ name: 'ends_at', type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
