import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderItemEntity } from './order-item.entity';

export enum OrderStatus {
  /** Written, event queued, nothing reserved yet. */
  PENDING = 'pending',
  /** Stock is held; payment has not been taken. M4 moves it on from here. */
  AWAITING_PAYMENT = 'awaiting_payment',
  CONFIRMED = 'confirmed',
  /** A business outcome: out of stock, or payment refused. */
  CANCELLED = 'cancelled',
  /** Something broke that was not the customer's doing. */
  FAILED = 'failed',
}

/**
 * A delivery address as the order remembers it.
 *
 * Deliberately not the users-service entity: no id, no `isDefault`, no
 * timestamps. Copying those would invite someone to treat this as a live
 * reference and follow it back, which is exactly what a frozen snapshot must
 * not be.
 */
export interface FrozenAddress {
  recipient: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode?: string | null;
  country: string;
  phone?: string | null;
}

@Entity({ name: 'orders' })
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ length: 3 })
  currency: string;

  /** The basket before anything was applied. */
  @Column({ name: 'subtotal_minor', type: 'integer', default: 0 })
  subtotalMinor: number;

  /** What promotions took off, summed. */
  @Column({ name: 'discount_minor', type: 'integer', default: 0 })
  discountMinor: number;

  @Column({ name: 'tax_minor', type: 'integer', default: 0 })
  taxMinor: number;

  /**
   * What the customer pays, and what `payment.requested` carries to Stripe.
   *
   * From M8 this includes tax. It is stored rather than derived from the
   * columns above for the same reason `order_items` copies its prices: an order
   * is a record of an amount the customer agreed to, and must not move when a
   * tax rate or a promotion changes tomorrow.
   */
  @Column({ name: 'total_minor', type: 'integer', default: 0 })
  totalMinor: number;

  /**
   * What delivery cost, frozen. Zero for orders placed before M10, and zero
   * when the basket earned free shipping — the two are distinguishable by
   * `shippingRateCode`, which is null only in the first case.
   */
  @Column({ name: 'shipping_minor', type: 'integer', default: 0 })
  shippingMinor: number;

  /** Which service level was chosen: 'standard', 'express'. */
  @Column({ name: 'shipping_rate_code', type: 'varchar', nullable: true })
  shippingRateCode?: string | null;

  /**
   * Where it is going, as agreed at checkout.
   *
   * A **snapshot**, not a reference. The customer's address book lives in
   * users-service and can be edited or deleted; an order is a record of what
   * was agreed, so it keeps its own copy — the same reason `order_items` copies
   * sku and price rather than pointing at a product.
   */
  @Column({ name: 'shipping_address', type: 'jsonb', nullable: true })
  shippingAddress?: FrozenAddress | null;

  /** The jurisdiction this order was taxed in. Null for orders placed before M8. */
  @Column({ name: 'tax_country', type: 'char', length: 2, nullable: true })
  taxCountry?: string | null;

  @Column({ name: 'tax_region', type: 'varchar', nullable: true })
  taxRegion?: string | null;

  /** Why the order failed, when it did. Free text in M2. */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null;

  @OneToMany(() => OrderItemEntity, (item) => item.order, { cascade: true, eager: true })
  items: OrderItemEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
