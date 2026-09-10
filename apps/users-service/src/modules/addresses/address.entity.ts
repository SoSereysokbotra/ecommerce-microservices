import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One saved delivery address.
 *
 * Two fields do more work than the rest: `country` and `region` are what the
 * tax rules and the shipping zones are keyed on. Since M8 the tax destination
 * has travelled on the request with a store default behind it, because nothing
 * in this system knew a customer's address. This is the row that ends that.
 *
 * Everything an order needs is **copied onto the order** at checkout, never
 * read back through this id. An address is edited; an order is a record of what
 * was agreed. The same reason `order_items` copies sku and price.
 */
@Entity({ name: 'customer_addresses' })
export class AddressEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** 'Home', 'Work'. Free text, for the shopper's own benefit. */
  @Column({ type: 'varchar', nullable: true })
  label: string | null;

  @Column({ type: 'varchar' })
  recipient: string;

  @Column({ type: 'varchar' })
  line1: string;

  @Column({ type: 'varchar', nullable: true })
  line2: string | null;

  @Column({ type: 'varchar' })
  city: string;

  /**
   * State or province code — 'CA', 'PA'.
   *
   * Nullable, and null is meaningful rather than missing: most countries have
   * nothing a shopper would recognise as a state, and a destination with no
   * region deliberately does **not** match a region-scoped shipping zone.
   */
  @Column({ type: 'varchar', nullable: true })
  region: string | null;

  @Column({ type: 'varchar', nullable: true })
  postcode: string | null;

  /** ISO 3166-1 alpha-2, upper case. Constrained at the column. */
  @Column({ type: 'char', length: 2 })
  country: string;

  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  /**
   * The one checkout pre-selects. At most one per customer, enforced by a
   * partial unique index rather than by this class — see the migration.
   */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
