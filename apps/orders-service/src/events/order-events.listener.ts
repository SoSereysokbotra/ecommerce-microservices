import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { OrderSagaService } from '../modules/orders/order-saga.service';

const CONSUMER = 'orders-service';

/**
 * Feeds saga replies into the orchestrator.
 *
 * Two independent layers keep repeats harmless: `handleOnce` stops the same
 * event being processed twice, and each saga transition additionally refuses to
 * fire unless the saga is on the step it expects. Either alone would mostly
 * work; together they also cover a republished event carrying a *new* id.
 */
@Injectable()
export class OrderEventsListener implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly saga: OrderSagaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'orders-service';

    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<Record<string, unknown>>);
    });

    // Re-drive anything left mid-flight by a previous process. Runs after the
    // subscription so replies to resumed commands are not missed.
    //
    // Never fatal: a service that cannot resume old sagas can still accept new
    // orders, and refusing to start would turn a recoverable problem into an
    // outage. It also breaks the deadlock where an unmigrated database stops
    // the service booting, which stops the migration being run.
    try {
      const resumed = await this.saga.resumeAll();
      if (resumed > 0) {
        this.logger.warn(`Resumed ${resumed} in-flight sagas on startup`);
      }
    } catch (error) {
      this.logger.error(
        `Saga resume failed on startup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<Record<string, unknown>>): Promise<void> {
    const handled = [
      'inventory.reserved',
      'inventory.reservation_failed',
      'inventory.committed',
      'inventory.released',
      'inventory.reservation_expired',
      'payment.authorized',
      'payment.declined',
      'payment.refunded',
    ];

    if (!handled.includes(event.eventType)) {
      return;
    }

    const orderId = event.payload?.orderId as string | undefined;
    if (!orderId) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has no orderId; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async () => {
      const reason = (event.payload?.reason as string) ?? undefined;

      switch (event.eventType) {
        case 'inventory.reserved':
          await this.saga.onStockReserved(orderId, event.correlationId);
          break;
        case 'inventory.reservation_failed':
          await this.saga.onReservationFailed(orderId, reason ?? 'Reservation failed');
          break;
        case 'payment.authorized':
          await this.saga.onPaymentAuthorized(orderId, event.correlationId);
          break;
        case 'payment.declined':
          await this.saga.onPaymentDeclined(
            orderId,
            reason ?? 'Payment declined',
            event.correlationId,
          );
          break;
        case 'inventory.committed':
          await this.saga.onInventoryCommitted(orderId);
          break;
        case 'inventory.released':
          await this.saga.onInventoryReleased(orderId);
          break;
        case 'payment.refunded':
          await this.saga.onPaymentRefunded(orderId, event.correlationId);
          break;
        case 'inventory.reservation_expired':
          await this.saga.onReservationExpired(orderId);
          break;
      }
    });

    if (!ran) {
      this.logger.debug(`Duplicate ${event.eventType} (${event.eventId}) ignored`);
    }
  }
}
