import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxService } from '@libs/outbox';
import { DataSource } from 'typeorm';
import { ReservationsService } from '../modules/stock/reservations.service';
import { ReservationStatus } from '../modules/stock/reservation.entity';

/**
 * Releases holds whose deadline has passed.
 *
 * This is the safety net under every other guarantee. The saga handles the
 * failures it can see — a decline, a shortfall — but it cannot handle the ones
 * it cannot: an orchestrator that dies and never comes back, a message dropped
 * by an operator, a bug nobody has found yet. Without an expiry, any of those
 * strands the stock forever, which is exactly what ADR-0002 documented.
 *
 * With it, the worst case is that stock is unavailable for the hold window and
 * then returns on its own.
 */
@Injectable()
export class ReservationExpiryJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationExpiryJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly intervalMs = Number(process.env.RESERVATION_SWEEP_MS ?? 30_000);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservations: ReservationsService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`Reservation expiry sweep every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed so tests can force a sweep instead of waiting for the timer. */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;

    try {
      const orderIds = await this.dataSource.transaction((manager) =>
        this.reservations.findExpired(manager),
      );

      let swept = 0;
      let failed = 0;

      // **One transaction per order, not one for the sweep.**
      //
      // Sweeping every order in a single transaction sounds tidier and is a
      // trap: one order that cannot be released fails the whole batch, so no
      // stock anywhere comes back. That is not hypothetical — during M8 a
      // single stock row with a drifted `reserved_qty` made every sweep throw
      // on CHK_stock_reserved_non_negative, every 30 seconds, and the saga's
      // safety net was down for the entire service until the row was repaired.
      //
      // These orders are independent of each other, so their failures should be
      // independent too. A poisoned one is logged and skipped; the rest still
      // get their stock back.
      for (const orderId of orderIds) {
        try {
          await this.dataSource.transaction(async (manager) => {
            // Marked EXPIRED rather than RELEASED so the two causes stay
            // distinguishable: a compensated saga and an abandoned one are very
            // different things when you are trying to understand a stock report.
            const released = await this.reservations.release(
              manager,
              orderId,
              ReservationStatus.EXPIRED,
            );

            await this.outbox.append(manager, {
              eventType: 'inventory.reservation_expired',
              aggregateId: orderId,
              payload: { orderId, lines: released },
            });

            this.logger.warn(`Expired ${released} stale reservations for order ${orderId}`);
          });
          swept += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            `Could not expire reservations for order ${orderId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (failed > 0) {
        this.logger.error(`Expiry sweep: ${swept} orders expired, ${failed} could not be`);
      }

      return swept;
    } catch (error) {
      this.logger.error(
        `Expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
