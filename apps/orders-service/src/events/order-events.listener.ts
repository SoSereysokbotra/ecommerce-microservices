import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { OrdersService } from '../modules/orders/orders.service';

const CONSUMER = 'orders-service';

@Injectable()
export class OrderEventsListener implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly orders: OrdersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'orders-service';

    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<Record<string, unknown>>);
    });

    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<Record<string, unknown>>): Promise<void> {
    // The queue is bound to several routing keys, including ones this service
    // publishes itself. Only act on what is actually addressed to us.
    const handled = [
      'inventory.reserved',
      'inventory.reservation_failed',
      'payment.authorized',
      'payment.declined',
    ];
    if (!handled.includes(event.eventType)) {
      return;
    }

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has no orderId; dropping`);
      return;
    }

    // Every effect below is wrapped so a redelivery cannot apply it twice.
    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async () => {
      switch (event.eventType) {
        case 'inventory.reserved':
          await this.orders.onStockReserved(orderId, event.correlationId);
          break;
        case 'inventory.reservation_failed':
          await this.orders.onReservationFailed(
            orderId,
            (event.payload?.reason as string) ?? 'Reservation failed',
            event.correlationId,
          );
          break;
        case 'payment.authorized':
          await this.orders.onPaymentAuthorized(orderId, event.correlationId);
          break;
        case 'payment.declined':
          await this.orders.onPaymentDeclined(
            orderId,
            (event.payload?.reason as string) ?? 'Payment declined',
            event.correlationId,
          );
          break;
      }
    });

    if (!ran) {
      this.logger.debug(`Duplicate ${event.eventType} (${event.eventId}) ignored`);
    }
  }
}
