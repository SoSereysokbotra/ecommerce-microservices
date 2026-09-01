import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService, OutboxService } from '@libs/outbox';
import { EntityManager } from 'typeorm';
import { ReservationsService } from '../modules/stock/reservations.service';

const CONSUMER = 'inventory-service';

interface OrderCreatedPayload {
  orderId: string;
  items: { productId: string; qty: number }[];
}

interface OrderIdPayload {
  orderId: string;
}

/**
 * Inventory's side of the saga.
 *
 * `order.created` is an event — something that happened. The other two are
 * commands the orchestrator sends: do this thing. Keeping the distinction in
 * the names makes the direction of control readable from the routing key alone.
 */
@Injectable()
export class InventoryEventsListener implements OnModuleInit {
  private readonly logger = new Logger(InventoryEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly reservations: ReservationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'inventory-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<Record<string, unknown>>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<Record<string, unknown>>): Promise<void> {
    const handled = ['order.created', 'inventory.commit_requested', 'inventory.release_requested'];
    if (!handled.includes(event.eventType)) {
      return;
    }

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has no orderId; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      switch (event.eventType) {
        case 'order.created':
          await this.onOrderCreated(manager, event as unknown as DomainEvent<OrderCreatedPayload>);
          break;
        case 'inventory.commit_requested':
          await this.onCommitRequested(manager, event as unknown as DomainEvent<OrderIdPayload>);
          break;
        case 'inventory.release_requested':
          await this.onReleaseRequested(manager, event as unknown as DomainEvent<OrderIdPayload>);
          break;
      }
    });

    if (!ran) {
      this.logger.debug(`Duplicate ${event.eventType} (${event.eventId}) ignored`);
    }
  }

  private async onOrderCreated(
    manager: EntityManager,
    event: DomainEvent<OrderCreatedPayload>,
  ): Promise<void> {
    const { orderId, items } = event.payload;

    if (!Array.isArray(items) || items.length === 0) {
      this.logger.warn(`order.created for ${orderId} has no items; dropping`);
      return;
    }

    try {
      await this.reservations.reserve(manager, orderId, items);
    } catch (error) {
      // Being short of stock is a business outcome, not a fault. Reporting it
      // as an event lets the saga decide; throwing would nack the message and
      // retry forever against stock that is not coming back.
      const reason = error instanceof Error ? error.message : String(error);

      await this.outbox.append(manager, {
        eventType: 'inventory.reservation_failed',
        aggregateId: orderId,
        correlationId: event.correlationId,
        payload: { orderId, reason },
      });

      this.logger.log(`Reservation failed for order ${orderId}: ${reason}`);
      return;
    }

    await this.outbox.append(manager, {
      eventType: 'inventory.reserved',
      aggregateId: orderId,
      correlationId: event.correlationId,
      payload: { orderId, items },
    });
  }

  /** The order was paid: the held units leave inventory permanently. */
  private async onCommitRequested(
    manager: EntityManager,
    event: DomainEvent<OrderIdPayload>,
  ): Promise<void> {
    const { orderId } = event.payload;
    const committed = await this.reservations.commit(manager, orderId);

    await this.outbox.append(manager, {
      eventType: 'inventory.committed',
      aggregateId: orderId,
      correlationId: event.correlationId,
      payload: { orderId, lines: committed },
    });
  }

  /**
   * Compensation. The single most important handler in the project: this is
   * the step whose absence in M2 left stock held for orders that never
   * completed.
   */
  private async onReleaseRequested(
    manager: EntityManager,
    event: DomainEvent<OrderIdPayload>,
  ): Promise<void> {
    const { orderId } = event.payload;
    const released = await this.reservations.release(manager, orderId);

    await this.outbox.append(manager, {
      eventType: 'inventory.released',
      aggregateId: orderId,
      correlationId: event.correlationId,
      payload: { orderId, lines: released },
    });
  }
}
