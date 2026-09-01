import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RabbitMQService } from '@libs/rabbitmq';
import { DataSource, EntityManager } from 'typeorm';
import { OUTBOX_OPTIONS, OutboxOptions } from './outbox.options';

interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_id: string;
  correlation_id: string | null;
  version: number;
  payload: Record<string, unknown>;
  created_at: Date;
}

/**
 * Publishes queued outbox rows to the broker, then marks them sent.
 *
 * Ordering of the two steps matters and is deliberate: publish first, mark
 * second. A crash in between republishes the event, which consumers deduplicate
 * via `processed_events`. The reverse order would lose it — and losing an event
 * is unrecoverable, while receiving one twice is merely something to handle.
 *
 * That is the standard trade in at-least-once systems: prefer duplicates over
 * loss, then make duplicates harmless.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbitmq: RabbitMQService,
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
  ) {}

  onModuleInit(): void {
    const interval = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => void this.drain(), interval);
    this.timer.unref?.();
    this.logger.log(`Outbox relay started (every ${interval}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed so tests can drive one cycle without waiting for the timer. */
  async drain(): Promise<number> {
    // Overlapping runs in one process would do redundant work; SKIP LOCKED
    // handles the cross-process case.
    if (this.running || !this.rabbitmq.isConnected()) {
      return 0;
    }

    this.running = true;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const batchSize = this.options.batchSize ?? 50;

        // The row locks live only as long as this transaction, so publishing
        // and marking must both happen inside it. Selecting in one transaction
        // and publishing after would release the locks first and let a second
        // instance publish the same rows.
        const rows: OutboxRow[] = await manager.query(
          `SELECT id, event_id, event_type, aggregate_id, correlation_id,
                  version, payload, created_at
             FROM outbox
            WHERE published_at IS NULL
            ORDER BY created_at
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );

        let published = 0;
        for (const row of rows) {
          if (await this.publishOne(manager, row)) {
            published += 1;
          }
        }
        return published;
      });
    } catch (error) {
      this.logger.error(`Outbox drain failed: ${describe(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async publishOne(manager: EntityManager, row: OutboxRow): Promise<boolean> {
    const envelope = {
      eventId: row.event_id,
      eventType: row.event_type,
      occurredAt: new Date(row.created_at).toISOString(),
      aggregateId: row.aggregate_id,
      correlationId: row.correlation_id ?? '',
      version: row.version,
      payload: row.payload,
    };

    try {
      await this.rabbitmq.publishOrThrow(row.event_type, envelope);
    } catch (error) {
      // Deliberately not rethrown: one unpublishable row must not roll back
      // the rows already published in this batch. It stays unpublished and the
      // next cycle retries it. A broker outage delays events, never loses them.
      await manager.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [row.id, describe(error)],
      );
      this.logger.warn(
        `Publish failed for ${row.event_type} (${row.event_id}): ${describe(error)}`,
      );
      return false;
    }

    await manager.query(`UPDATE outbox SET published_at = now() WHERE id = $1`, [row.id]);
    this.logger.debug(`Relayed ${row.event_type} (${row.event_id}) [${envelope.correlationId}]`);
    return true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
