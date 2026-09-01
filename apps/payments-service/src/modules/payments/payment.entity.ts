import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  /** Intent created at the provider; the customer has not paid yet. */
  REQUIRES_PAYMENT = 'requires_payment',
  AUTHORIZED = 'authorized',
  DECLINED = 'declined',
  REFUNDED = 'refunded',
}

@Entity({ name: 'payments' })
@Index('IDX_payments_order_id', ['orderId'])
export class PaymentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  /**
   * Sent to Stripe as its `Idempotency-Key`.
   *
   * This is the single most important column in the service. If the same key
   * reaches Stripe twice — a retried event, a redelivered message, a restarted
   * pod — Stripe returns the original PaymentIntent instead of creating a
   * second one. Without it, an at-least-once event bus eventually charges a
   * customer twice.
   */
  @Column({ name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ default: 'stripe' })
  provider: string;

  /** The provider's id for the intent, e.g. pi_3Q... */
  @Column({ name: 'provider_ref', type: 'varchar', nullable: true })
  providerRef?: string | null;

  /**
   * Not a secret in the usual sense: it is meant for the browser, and is
   * useless without the publishable key. Stored so a reloading customer can
   * resume the same payment rather than starting a second one.
   */
  @Column({ name: 'client_secret', type: 'varchar', nullable: true })
  clientSecret?: string | null;

  @Column({ name: 'amount_minor', type: 'integer' })
  amountMinor: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.REQUIRES_PAYMENT })
  status: PaymentStatus;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
