import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService, OutboxService } from '@libs/outbox';
import { EntityManager } from 'typeorm';
import { StockService } from '../modules/stock/stock.service';

const CONSUMER = 'inventory-service';

interface OrderCreatedPayload {
  orderId: string;
  items: { productId: string; qty: number }[];
}

@Injectable()
export class InventoryEventsListener implements OnModuleInit {
  private readonly logger = new Logger(InventoryEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly stock: StockService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'inventory-service';

    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<OrderCreatedPayload>);
    });

    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<OrderCreatedPayload>): Promise<void> {
    if (event.eventType !== 'order.created') {
      return;
    }

    const { orderId, items } = event.payload ?? ({} as OrderCreatedPayload);
    if (!orderId || !Array.isArray(items)) {
      this.logger.warn(`order.created (${event.eventId}) is malformed; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      await this.reserveAndReply(manager, event, orderId, items);
    });

    if (!ran) {
      this.logger.debug(`Duplicate order.created (${event.eventId}) ignored`);
    }
  }

  /**
   * Reserve the stock and queue the reply, both inside the transaction the
   * idempotency guard opened.
   *
   * Everything that matters is in one transaction: the processed-event marker,
   * the stock change, and the outgoing event. Any failure rolls back all three,
   * and the message is redelivered to try again cleanly.
   */
  private async reserveAndReply(
    manager: EntityManager,
    event: DomainEvent<OrderCreatedPayload>,
    orderId: string,
    items: { productId: string; qty: number }[],
  ): Promise<void> {
    try {
      await this.stock.reserveWithManager(manager, items);
    } catch (error) {
      // A shortfall is a business outcome, not a bug: report it as an event
      // rather than throwing, which would nack the message and retry forever
      // against stock that is not coming back.
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

    this.logger.log(`Reserved stock for order ${orderId} [${event.correlationId}]`);
  }
}
