import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Record that this consumer has already handled this event.
 *
 * RabbitMQ guarantees at-least-once delivery, so a message can arrive twice —
 * after a reconnect, a redelivery, or a relay retry. The composite primary key
 * makes a second attempt a unique-violation, which the consumer treats as
 * "already done".
 *
 * The row must be inserted in the same transaction as the effect it guards.
 * Split them and a crash in between either double-applies the work or drops it.
 */
@Entity({ name: 'processed_events' })
export class ProcessedEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  /** Two different consumers must each be able to handle the same event. */
  @PrimaryColumn({ type: 'varchar' })
  consumer: string;

  @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'now()' })
  processedAt: Date;
}
