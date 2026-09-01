import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Where an order is in the checkout saga.
 *
 * Named for what the saga is *waiting for*, not what just happened, because
 * that is the question resume has to answer after a crash: what did we ask for
 * and never hear back about?
 */
export enum SagaStep {
  AWAITING_RESERVATION = 'awaiting_reservation',
  AWAITING_PAYMENT = 'awaiting_payment',
  AWAITING_COMMIT = 'awaiting_commit',
  /** Compensating: waiting for the money to come back. */
  AWAITING_REFUND = 'awaiting_refund',
  /** Compensating: waiting for the stock to go back. */
  AWAITING_RELEASE = 'awaiting_release',
  DONE = 'done',
}

export enum SagaOutcome {
  RUNNING = 'running',
  COMPLETED = 'completed',
  COMPENSATED = 'compensated',
}

@Entity({ name: 'order_saga' })
@Index('IDX_order_saga_live', ['outcome', 'updatedAt'])
export class OrderSagaEntity {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'current_step', type: 'enum', enum: SagaStep })
  currentStep: SagaStep;

  @Column({ type: 'enum', enum: SagaOutcome, default: SagaOutcome.RUNNING })
  outcome: SagaOutcome;

  /**
   * True once the saga has turned around and is undoing its own work.
   *
   * Kept as its own flag rather than inferred from the step, because "which
   * direction is this saga going" is the first thing you want to know when
   * looking at a stuck order.
   */
  @Column({ default: false })
  compensating: boolean;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;

  /** How many times resume has re-driven this saga. High values mean stuck. */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'correlation_id', type: 'varchar', nullable: true })
  correlationId?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
