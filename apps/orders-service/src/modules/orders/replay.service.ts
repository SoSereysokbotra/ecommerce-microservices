import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxService } from '@libs/outbox';
import { OrderEntity, OrderStatus } from './order.entity';

/**
 * Re-announces co-purchase items for historical confirmed orders.
 *
 * ## Why a dedicated replay event? (M14 plan §7, ADR-0012)
 *
 * A read model must be rebuildable from events alone. But orders-service's outbox
 * is a delivery queue, not a retained log. Once published, entries are ephemeral.
 *
 * Re-emitting `order.confirmed` on the general bus would be dangerous: shipping,
 * reviews, and future notification services all subscribe to `order.confirmed`.
 * Even with idempotency guards on each consumer, relying on every past and future
 * subscriber to safely no-op during a bulk backfill violates event isolation.
 *
 * Therefore, we emit `order.co_purchase_replay` which is bound solely to
 * recommendations-service's queue.
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async replayCoPurchases(correlationId?: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const orders = await manager.find(OrderEntity, {
        where: { status: OrderStatus.CONFIRMED },
        relations: ['items'],
        order: { createdAt: 'ASC' },
      });

      for (const order of orders) {
        await this.outbox.append(manager, {
          eventType: 'order.co_purchase_replay',
          aggregateId: order.id,
          correlationId: correlationId ?? undefined,
          payload: {
            orderId: order.id,
            items: (order.items ?? []).map((item) => ({
              productId: item.productId,
            })),
          },
        });
      }

      this.logger.log(`Appended order.co_purchase_replay for ${orders.length} confirmed order(s)`);
      return orders.length;
    });
  }
}
