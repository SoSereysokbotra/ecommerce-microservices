import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { EntityManager } from 'typeorm';
import { CartEntity } from '../modules/cart/cart.entity';
import { CartItemEntity } from '../modules/cart/cart-item.entity';

const CONSUMER = 'cart-service';

interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
}

/**
 * Empty a shopper's cart once their order exists.
 *
 * Doing this by consuming `order.created` rather than having orders-service
 * call cart-service keeps the dependency running cart → events, the direction
 * already used everywhere else, and leaves `POST /orders` — the saga's entry
 * point — untouched. The reasoning is in docs/M7_CART_PLAN.md §4.
 *
 * Deliberately **not** subscribed to `order.cancelled`: a cancelled order does
 * not put the cart back. Re-populating it minutes later, possibly while the
 * shopper is building a new one, would be surprising. That is what a "reorder"
 * button is for.
 */
@Injectable()
export class CartEventsListener implements OnModuleInit {
  private readonly logger = new Logger(CartEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'cart-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<Record<string, unknown>>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<Record<string, unknown>>): Promise<void> {
    if (event.eventType !== 'order.created') {
      return;
    }

    const customerId = event.payload?.customerId as string | undefined;
    if (!customerId) {
      // A guest cart cannot be reached from here anyway — it is keyed by a
      // token the shopper holds, not by an id the event carries. Nothing to do.
      this.logger.warn(`order.created (${event.eventId}) has no customerId; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      await this.clearCart(manager, event as unknown as DomainEvent<OrderCreatedPayload>);
    });

    if (!ran) {
      this.logger.debug(`Duplicate order.created (${event.eventId}) ignored`);
    }
  }

  /**
   * Runs inside the idempotency transaction, so the "already handled" marker
   * and the emptying commit together — a redelivery cannot empty a cart the
   * shopper has since refilled.
   */
  private async clearCart(
    manager: EntityManager,
    event: DomainEvent<OrderCreatedPayload>,
  ): Promise<void> {
    const { orderId, customerId } = event.payload;

    const cart = await manager.getRepository(CartEntity).findOne({ where: { customerId } });

    if (!cart) {
      // Ordinary: the order came from a guest checkout, or the cart was never
      // persisted. Nothing to empty, and the event is still marked handled.
      this.logger.debug(`No cart for ${customerId} (order ${orderId})`);
      return;
    }

    const { affected } = await manager.getRepository(CartItemEntity).delete({ cartId: cart.id });

    // The row itself stays. `updated_at` is what the abandonment sweep reads,
    // and deleting the cart would lose that history.
    await manager.getRepository(CartEntity).update({ id: cart.id }, { updatedAt: new Date() });

    this.logger.log(`Cleared ${affected ?? 0} line(s) for ${customerId} after order ${orderId}`);
  }
}
