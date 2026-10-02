import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { PurchasedLine, PurchasesService } from '../modules/reviews/purchases.service';

const CONSUMER = 'reviews-service';

interface OrderConfirmedPayload {
  orderId: string;
  customerId: string;
  items?: PurchasedLine[];
}

/**
 * The right to review, derived from an event.
 *
 * `order.confirmed` is the saga's terminal success, emitted in the same
 * transaction as the status change. M13 step 1 added `items` to it for exactly
 * this consumer — the third time this project has put a field on an event
 * because a consumer genuinely needed it (M8's rule, M10's address, now this).
 *
 * ## Two guards, as everywhere
 *
 *   1. `handleOnce` writes a `processed_events` marker in the **same
 *      transaction** as the purchase rows, so a redelivered event id is a
 *      no-op.
 *   2. `UQ_purchases_customer_product_order` refuses a **republished** event
 *      with a new id, which the marker cannot catch.
 *
 * Exactly shipping-service's shape, and for the same reason: M9 proved guard 1
 * alone insufficient by testing precisely case 2.
 *
 * `order.cancelled` is deliberately not consumed. A cancelled order never
 * reached CONFIRMED, so it never granted anything to take away. A refunded
 * order is a different question — the customer did buy it — and is left alone
 * until someone asks for it.
 */
@Injectable()
export class OrderEventsListener implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly purchases: PurchasesService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'reviews-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<OrderConfirmedPayload>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  async handle(event: DomainEvent<OrderConfirmedPayload>): Promise<void> {
    if (event.eventType !== 'order.confirmed') {
      return;
    }

    const payload = event.payload;
    if (!payload?.orderId || !payload?.customerId) {
      // Nothing to key a purchase on. Dropping rather than nacking, because a
      // redelivery would be just as unusable and would loop forever.
      this.logger.warn(`order.confirmed (${event.eventId}) is missing ids; dropping`);
      return;
    }

    const items = (payload.items ?? []).filter((item) => item?.productId);
    if (items.length === 0) {
      // Every order placed before M13 step 1. Not an error — those customers
      // simply cannot review, and backfilling a right to review from an event
      // that never carried the products would be inventing one.
      this.logger.warn(`order.confirmed (${event.eventId}) carries no items; nothing to record`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      const inserted = await this.purchases.recordPurchase(manager, {
        customerId: payload.customerId,
        orderId: payload.orderId,
        items,
      });

      if (inserted === 0) {
        // The UNIQUE refused every line: a republished event with a new id.
        // Not an error — it is the second guard doing its job.
        this.logger.log(`Order ${payload.orderId} already recorded; nothing new`);
        return;
      }

      this.logger.log(
        `Recorded ${inserted} purchase${inserted === 1 ? '' : 's'} for order ${payload.orderId}`,
      );
    });

    if (!ran) {
      this.logger.debug(`Duplicate order.confirmed (${event.eventId}) ignored`);
    }
  }
}
