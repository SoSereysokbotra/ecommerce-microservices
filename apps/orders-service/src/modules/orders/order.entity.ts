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

  @Column({ name: 'total_minor', type: 'integer', default: 0 })
  totalMinor: number;

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
