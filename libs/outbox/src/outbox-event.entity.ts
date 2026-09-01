import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An event waiting to be published.
 *
 * Rows are written inside the same transaction as the business change they
 * describe, so the two either both commit or neither does. A separate relay
 * publishes them afterwards. That is the whole trick: the broker is never part
 * of the transaction, so it being down cannot lose the event or block the write.
 */
@Entity({ name: 'outbox' })
@Index('IDX_outbox_unpublished', ['publishedAt', 'createdAt'])
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The consumer-facing idempotency key. Stable across republish attempts. */
  @Column({ name: 'event_id', type: 'uuid', unique: true })
  eventId: string;

  @Column({ name: 'event_type' })
  eventType: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId: string;

  @Column({ name: 'correlation_id', type: 'varchar', nullable: true })
  correlationId?: string | null;

  @Column({ type: 'integer', default: 1 })
  version: number;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** NULL until the relay has successfully handed it to the broker. */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
