import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ReservationStatus {
  /** Stock is set aside for an order that has not completed yet. */
  HELD = 'held',
  /** The order was paid: the units have actually left. */
  COMMITTED = 'committed',
  /** The saga compensated: the units went back to available. */
  RELEASED = 'released',
  /** Nobody finished the order in time and the hold lapsed. */
  EXPIRED = 'expired',
}

/**
 * A specific quantity of a specific product, held for a specific order.
 *
 * M2 had none of this — a reservation was only a number on the stock row, so
 * held stock had no owner and nothing could ever release it correctly. That is
 * the defect ADR-0002 recorded, and this table is the fix: every held unit is
 * traceable to an order and carries its own deadline.
 */
@Entity({ name: 'reservations' })
@Index('IDX_reservations_order_id', ['orderId'])
@Index('IDX_reservations_expiry', ['status', 'expiresAt'])
@Index('UQ_reservations_order_product', ['orderId', 'productId'], { unique: true })
export class ReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ type: 'integer' })
  qty: number;

  @Column({ type: 'enum', enum: ReservationStatus, default: ReservationStatus.HELD })
  status: ReservationStatus;

  /**
   * When this hold lapses if the saga never finishes.
   *
   * Without it a saga that dies between reserving and paying leaks the stock
   * permanently. The expiry job is the safety net under every other guarantee
   * in the system: whatever else goes wrong, held stock comes back.
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
