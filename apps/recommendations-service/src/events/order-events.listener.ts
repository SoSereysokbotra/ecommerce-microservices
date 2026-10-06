import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { RecommendationsService } from '../modules/recommendations/recommendations.service';

const CONSUMER = 'recommendations-service';

interface OrderConfirmedPayload {
  orderId?: string;
  items?: Array<{ productId: string }>;
}

/**
 * Co-purchase graph derivation from confirmed order facts.
 *
 * `order.confirmed` is the saga's terminal success fact, emitted atomically with
 * the order status change. recommendations-service is the third consumer of this
 * leaf event (M14 plan §3), following shipping-service (M10) and reviews-service (M13).
 *
 * ## Idempotency and transactional deduplication
 *
 * M14 plan §4: A co-purchase counter is an accumulator (`count = count + 1`).
 * Unlike search-service's full-document state replacements (ADR-0011), an accumulator
 * cannot be made idempotent through version clocks. Applying a redelivered event twice
 * would permanently corrupt the co-purchase counts without detection.
 *
 * Therefore, `handleOnce` inserts the `processed_events` marker inside the **same
 * database transaction** as the counter increments.
 *
 * Orders with no items, or fewer than 2 distinct products, are acknowledged and
 * skipped without error (M14 plan §2, §6).
 */
@Injectable()
export class OrderEventsListener implements OnModuleInit {
  private readonly logger = new Logger(OrderEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly recommendations: RecommendationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'recommendations-service';
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
    const items = (payload?.items ?? []).filter((item) => Boolean(item?.productId));

    // An order with no items carries nothing to pair. Acknowledged and skipped.
    if (items.length === 0) {
      this.logger.warn(`order.confirmed (${event.eventId}) carries no items; skipping`);
      return;
    }

    // Single-item baskets or orders with only duplicate lines cannot form co-purchases.
    // Acknowledged and skipped without database interaction (M14 plan §6, §13).
    const distinctProductIds = new Set(items.map((i) => i.productId));
    if (distinctProductIds.size < 2) {
      this.logger.log(
        `order.confirmed (${event.eventId}) has fewer than 2 distinct products; skipping`,
      );
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      const recorded = await this.recommendations.recordCoPurchases(manager, items);
      this.logger.log(
        `Recorded ${recorded} co-purchase pair(s) for order ${payload?.orderId ?? event.aggregateId}`,
      );
    });

    if (!ran) {
      this.logger.debug(`Duplicate order.confirmed (${event.eventId}) ignored`);
    }
  }
}
