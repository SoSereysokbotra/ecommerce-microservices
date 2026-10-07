import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { getCorrelationId, getTraceparent } from '@libs/common';
import { OutboxEventEntity } from './outbox-event.entity';

export interface AppendEventInput {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  traceparent?: string | null;
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
   * Automatically inherits active correlationId and W3C traceparent from
   * AsyncLocalStorage context if not explicitly provided.
   */
  async append(manager: EntityManager, input: AppendEventInput): Promise<OutboxEventEntity> {
    const correlationId = input.correlationId ?? getCorrelationId() ?? null;
    const traceparent = input.traceparent ?? getTraceparent() ?? null;

    const payload = {
      ...input.payload,
      ...(traceparent && !input.payload.traceparent ? { traceparent } : {}),
    };

    const event = manager.create(OutboxEventEntity, {
      eventId: input.eventId ?? randomUUID(),
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      correlationId,
      version: input.version ?? 1,
      payload,
      publishedAt: null,
      attempts: 0,
    });

    return manager.save(OutboxEventEntity, event);
  }
}
