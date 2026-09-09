import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { EntityManager } from 'typeorm';
import { CouponsService } from '../modules/coupons/coupons.service';

const CONSUMER = 'pricing-service';

interface OrderTerminalPayload {
  orderId: string;
  customerId?: string;
  reason?: string;
}

/**
 * Turns a held coupon into a spent one, or gives it back.
 *
 * A coupon use is claimed when the order is created and is only a possibility.
 * Whether it becomes real is decided minutes later by the saga, so this service
 * has to hear how the story ended:
 *
 *   order.confirmed  -> the use is spent for good
 *   order.cancelled  -> the use goes back
 *
 * Both events are new in M9. The saga reached its terminal states silently
 * before, because nothing needed to know — see the note in
 * `OrderSagaService.announceCancelled`.
 *
 * ## Why this cannot be sloppy
 *
 * The bus delivers **at least once**, so `order.cancelled` will eventually
 * arrive twice for some order. Crediting a use twice would let an eleventh
 * customer redeem a ten-use coupon — the exact failure this milestone exists to
 * prevent, arriving through the back door.
 *
 * Two things stop it, and they are deliberately independent:
 *
 *   1. `handleOnce` writes a `processed_events` marker in the **same
 *      transaction** as the effect, so a redelivery is a no-op.
 *   2. `release()` only acts on a redemption still HELD, so even an event with
 *      a *new* id — a genuine republish, which marker 1 cannot catch — credits
 *      the use at most once.
 *
 * That is the same belt-and-braces the saga uses: the marker handles
 * redelivery, the status guard handles republication.
 */
@Injectable()
export class PricingEventsListener implements OnModuleInit {
  private readonly logger = new Logger(PricingEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly coupons: CouponsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'pricing-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<OrderTerminalPayload>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<OrderTerminalPayload>): Promise<void> {
    const handled = ['order.confirmed', 'order.cancelled'];
    if (!handled.includes(event.eventType)) {
      return;
    }

    const orderId = event.payload?.orderId;
    if (!orderId) {
      this.logger.warn(`${event.eventType} (${event.eventId}) has no orderId; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      if (event.eventType === 'order.confirmed') {
        await this.onOrderConfirmed(manager, orderId);
      } else {
        await this.onOrderCancelled(manager, orderId, event.payload.reason);
      }
    });

    if (!ran) {
      this.logger.debug(`Duplicate ${event.eventType} (${event.eventId}) ignored`);
    }
  }

  /** The order is real. The use is spent. */
  private async onOrderConfirmed(manager: EntityManager, orderId: string): Promise<void> {
    const committed = await this.coupons.commit(orderId, manager);

    // Most orders carry no coupon, so "nothing to commit" is the common case
    // and not worth a warning.
    if (committed) {
      this.logger.log(`Coupon use committed for order ${orderId}`);
    }
  }

  /** The order died. Whatever it was holding goes back. */
  private async onOrderCancelled(
    manager: EntityManager,
    orderId: string,
    reason?: string,
  ): Promise<void> {
    const released = await this.coupons.release(orderId, manager);

    if (released) {
      this.logger.log(
        `Coupon use released for cancelled order ${orderId} (${reason ?? 'no reason'})`,
      );
    }
  }
}
