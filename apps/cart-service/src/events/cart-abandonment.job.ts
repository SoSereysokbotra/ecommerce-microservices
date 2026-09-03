import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxService } from '@libs/outbox';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { CartEntity } from '../modules/cart/cart.entity';
import { CartItemEntity } from '../modules/cart/cart-item.entity';

/**
 * Flags signed-in carts nobody has touched for a while.
 *
 * Only signed-in carts need this. Guest carts live in Redis with a TTL and
 * expire on their own, which is the clearest illustration of why the two
 * stores differ — see docs/M7_CART_PLAN.md §1.
 *
 * **Nothing consumes `cart.abandoned` yet.** Recovery email is R3 at the
 * earliest. It is emitted so the history exists and the outbox path is
 * exercised; §7 of the plan is explicit that cutting this job would cost
 * nothing today.
 */
@Injectable()
export class CartAbandonmentJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartAbandonmentJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly intervalMs = Number(process.env.CART_SWEEP_MS ?? 60_000);
  private readonly afterDays = Number(process.env.CART_ABANDON_AFTER_DAYS ?? 7);
  /** Cap per tick so a first run over a long-neglected table cannot stall the service. */
  private readonly batchSize = Number(process.env.CART_SWEEP_BATCH ?? 100);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `Cart abandonment sweep every ${this.intervalMs}ms, after ${this.afterDays} day(s)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed so a test can force a sweep rather than wait for the timer. */
  async sweep(): Promise<number> {
    // Overlapping sweeps would both select the same carts before either had
    // flagged them, and emit twice.
    if (this.running) {
      return 0;
    }
    this.running = true;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const cutoff = new Date(Date.now() - this.afterDays * 24 * 60 * 60 * 1000);

        const stale = await manager.getRepository(CartEntity).find({
          where: { updatedAt: LessThan(cutoff), abandonedAt: IsNull() },
          order: { updatedAt: 'ASC' },
          take: this.batchSize,
        });

        let flagged = 0;

        for (const cart of stale) {
          const items = await manager
            .getRepository(CartItemEntity)
            .find({ where: { cartId: cart.id } });

          // An empty cart is not an abandoned one. It is usually a cart that
          // became an order, and `updated_at` has not moved since.
          if (items.length === 0) {
            continue;
          }

          await this.outbox.append(manager, {
            eventType: 'cart.abandoned',
            aggregateId: cart.id,
            payload: {
              cartId: cart.id,
              customerId: cart.customerId,
              lastUpdatedAt: cart.updatedAt.toISOString(),
              items: items.map((item) => ({ productId: item.productId, qty: item.qty })),
            },
          });

          // Flagged in the same transaction as the event, so a crash between
          // the two cannot emit without recording it — the same reasoning as
          // the outbox itself.
          //
          // Raw SQL on purpose: repository.update() fires @UpdateDateColumn,
          // which would bump `updated_at` and make a cart the shopper has not
          // touched in a week look freshly active the moment it was flagged.
          await manager.query('UPDATE carts SET abandoned_at = now() WHERE id = $1', [cart.id]);

          flagged += 1;
        }

        if (flagged > 0) {
          this.logger.log(`Flagged ${flagged} abandoned cart(s)`);
        }

        return flagged;
      });
    } catch (error) {
      this.logger.error(
        `Abandonment sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
