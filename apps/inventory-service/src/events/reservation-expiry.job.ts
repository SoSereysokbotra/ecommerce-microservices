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
      return await this.dataSource.transaction(async (manager) => {
        const orderIds = await this.reservations.findExpired(manager);

        for (const orderId of orderIds) {
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
        }

        return orderIds.length;
      });
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
