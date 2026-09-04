import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One tax rule, scoped from broad to narrow.
 *
 * `region` and `category` are both nullable, and null means "matches
 * everything" rather than "unknown" — a row with both null is the country-wide
 * default. Resolution picks the most specific match; see `resolveTaxRule` in
 * quote.ts and docs/M8_PRICING_PLAN.md §7.
 *
 * There are deliberately no validity dates. A rate change is rare, and orders
 * are protected from one by storing their own totals rather than recomputing
 * them, so dated rows would add a dimension to every lookup and buy nothing.
 */
@Entity({ name: 'tax_rates' })
export class TaxRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** ISO 3166-1 alpha-2, upper case. */
  @Column({ type: 'char', length: 2 })
  country: string;

  /** State or province code. Null matches the whole country. */
  @Column({ type: 'varchar', nullable: true })
  region: string | null;

  /** Catalog category slug. Null matches every category. */
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  /**
   * Basis points — 725 is 7.25%.
   *
   * An integer rather than a `numeric`, because a decimal column invites a
   * float in the code that reads it, and there is no floating point value
   * anywhere else in the pricing path.
   */
  @Column({ name: 'rate_bp', type: 'integer' })
  rateBp: number;

  /**
   * Whether catalog prices already contain this tax.
   *
   * US sales tax is added to the shelf price; EU and UK VAT is already inside
   * it. Same rate, different total.
   */
  @Column({ name: 'prices_include_tax', type: 'boolean', default: false })
  pricesIncludeTax: boolean;

  /** Human label, shown on the storefront's tax line. */
  @Column()
  name: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
