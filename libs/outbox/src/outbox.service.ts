import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { OutboxEventEntity } from './outbox-event.entity';

export interface AppendEventInput {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  /** Supply only to make a republish reuse the original id. */
  eventId?: string;
  version?: number;
}

@Injectable()
export class OutboxService {
  /**
   * Queue an event for publication.
   *
   * Takes an `EntityManager` rather than using its own repository, because the
   * caller must pass the manager from the transaction that is making the
   * business change. That is what makes the write atomic:
   *
   *   await dataSource.transaction(async (manager) => {
   *     const order = await manager.save(Order, { ... });
   *     await outbox.append(manager, { eventType: 'order.created', ... });
   *   });
   *
   * Calling this outside a transaction compiles and runs, and quietly gives up
   * the guarantee — the event can commit while the business change rolls back.
   */
  async append(manager: EntityManager, input: AppendEventInput): Promise<OutboxEventEntity> {
    const event = manager.create(OutboxEventEntity, {
      eventId: input.eventId ?? randomUUID(),
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      correlationId: input.correlationId ?? null,
      version: input.version ?? 1,
      payload: input.payload,
      publishedAt: null,
      attempts: 0,
    });

    return manager.save(OutboxEventEntity, event);
  }
}
