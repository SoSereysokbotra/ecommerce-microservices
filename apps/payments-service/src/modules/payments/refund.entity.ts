import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'refunds' })
@Index('IDX_refunds_payment_id', ['paymentId'])
export class RefundEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId: string;

  /** Also sent to Stripe as an Idempotency-Key: never refund twice. */
  @Column({ name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ name: 'amount_minor', type: 'integer' })
  amountMinor: number;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({ name: 'provider_ref', type: 'varchar', nullable: true })
  providerRef?: string | null;

  @Column({ default: 'pending' })
  status: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
