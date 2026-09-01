import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Every webhook Stripe has delivered to us.
 *
 * Stripe retries a webhook until it gets a 2xx, and may deliver the same event
 * more than once even after success. The primary key on the provider's own
 * event id makes a repeat a unique-violation, which is the whole deduplication
 * mechanism: no lookup-then-insert race, just let the database decide.
 */
@Entity({ name: 'webhook_events' })
export class WebhookEventEntity {
  /** Stripe's event id, e.g. evt_3Q... */
  @PrimaryColumn({ name: 'provider_event_id', type: 'varchar' })
  providerEventId: string;

  @Column()
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;
}
