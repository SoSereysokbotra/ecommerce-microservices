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
