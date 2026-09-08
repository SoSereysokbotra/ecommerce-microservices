import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, LessThan } from 'typeorm';
import { StockEntity } from './stock.entity';
import { ReservationEntity, ReservationStatus } from './reservation.entity';

export interface ReservationLine {
  productId: string;
  qty: number;
}

/**
 * The three operations the saga drives, plus the safety net.
 *
 *   reserve  — move available -> reserved, and record who holds it
 *   commit   — the order was paid; the units leave for good
 *   release  — compensation; the units go back to available
 *   expire   — nobody finished in time; release automatically
 *
 * Every one takes the caller's EntityManager so it joins the transaction that
 * also writes the processed-event marker and the outgoing event. Opening a
 * separate transaction here would break the guarantee those depend on.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  /** How long a hold survives without the saga completing. */
  private readonly holdMinutes = Number(process.env.RESERVATION_HOLD_MINUTES ?? 15);

  /**
   * Read a stock row **for update**, so nobody else can change it until this
   * transaction ends.
   *
   * Every operation here is a read-modify-write: load the row, add or subtract,
   * save. Without the lock two of them interleave and one update is lost —
   * `reserved_qty` then disagrees with the reservations that actually exist.
   * That is not a theoretical risk: it happened during M8's end-to-end testing,
   * when the expiry sweep and a commit touched the same product at the same
   * moment, and the resulting drift made `reserved_qty` too low. Every
   * subsequent commit *and* release for that product then violated
   * CHK_stock_reserved_non_negative, which wedged the expiry sweep for the
   * whole service — the saga's last line of defence — until the row was
   * repaired by hand.
   *
   * The constraint did its job by refusing the bad write. The lock is what
   * stops the bad write being attempted.
   */
  private lockStock(manager: EntityManager, productId: string): Promise<StockEntity | null> {
    return manager.getRepository(StockEntity).findOne({
      where: { productId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async reserve(
    manager: EntityManager,
    orderId: string,
    lines: ReservationLine[],
  ): Promise<ReservationEntity[]> {
    const reservations = manager.getRepository(ReservationEntity);

    // A redelivered order.created must not reserve twice. The unique index on
    // (order_id, product_id) is the real guard; this check makes the common
    // case a cheap no-op instead of a caught constraint violation.
    const already = await reservations.find({ where: { orderId } });
    if (already.length > 0) {
      this.logger.log(`Order ${orderId} already has ${already.length} reservations; reusing`);
      return already;
    }

    const stock = manager.getRepository(StockEntity);
    const expiresAt = new Date(Date.now() + this.holdMinutes * 60_000);
    const created: ReservationEntity[] = [];

    // Locks are taken in a fixed order — by product id — so two orders holding
    // an overlapping basket can never each hold the row the other is waiting
    // for. Without this, deadlocks are a matter of timing rather than luck.
    const ordered = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));

    for (const line of ordered) {
      const row = await this.lockStock(manager, line.productId);

      if (!row) {
        throw new NotFoundException(`No stock record for product '${line.productId}'`);
      }

      if (row.availableQty < line.qty) {
        // Throwing rolls back the whole transaction, so an order that is short
        // on its third line does not leave the first two held.
        throw new ConflictException(
          `Insufficient stock for product '${line.productId}': ` +
            `requested ${line.qty}, available ${row.availableQty}`,
        );
      }

      row.availableQty -= line.qty;
      row.reservedQty += line.qty;
      await stock.save(row);

      created.push(
        await reservations.save(
          reservations.create({
            orderId,
            productId: line.productId,
            qty: line.qty,
            status: ReservationStatus.HELD,
            expiresAt,
          }),
        ),
      );
    }

    this.logger.log(
      `Held ${created.length} lines for order ${orderId}, expiring ${expiresAt.toISOString()}`,
    );
    return created;
  }

  /**
   * The order was paid. Held units leave inventory for good.
   *
   * Only `reservedQty` drops — `availableQty` was already reduced at reserve
   * time. Touching available here would double-count the sale.
   */
  async commit(manager: EntityManager, orderId: string): Promise<number> {
    const reservations = manager.getRepository(ReservationEntity);
    const held = await reservations.find({
      where: { orderId, status: ReservationStatus.HELD },
    });

    if (held.length === 0) {
      // Either already committed or never existed. Both are fine on a repeat.
      this.logger.debug(`No held reservations to commit for order ${orderId}`);
      return 0;
    }

    const stock = manager.getRepository(StockEntity);

    for (const reservation of [...held].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const row = await this.lockStock(manager, reservation.productId);
      if (row) {
        row.reservedQty -= reservation.qty;
        await stock.save(row);
      }
      reservation.status = ReservationStatus.COMMITTED;
      await reservations.save(reservation);
    }

    this.logger.log(`Committed ${held.length} reservations for order ${orderId}`);
    return held.length;
  }

  /**
   * Compensation: give the stock back.
   *
   * Idempotent by design — it only acts on rows still HELD. Running it twice
   * credits the stock once, which is what makes it safe to drive from an
   * at-least-once event bus.
   */
  async release(
    manager: EntityManager,
    orderId: string,
    status: ReservationStatus = ReservationStatus.RELEASED,
  ): Promise<number> {
    const reservations = manager.getRepository(ReservationEntity);
    const held = await reservations.find({
      where: { orderId, status: ReservationStatus.HELD },
    });

    if (held.length === 0) {
      this.logger.debug(`No held reservations to release for order ${orderId}`);
      return 0;
    }

    const stock = manager.getRepository(StockEntity);

    for (const reservation of [...held].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const row = await this.lockStock(manager, reservation.productId);
      if (row) {
        row.availableQty += reservation.qty;
        row.reservedQty -= reservation.qty;
        await stock.save(row);
      }
      reservation.status = status;
      await reservations.save(reservation);
    }

    this.logger.log(`Released ${held.length} reservations for order ${orderId} (${status})`);
    return held.length;
  }

  /** Held reservations whose deadline has passed, grouped by order. */
  async findExpired(manager: EntityManager, limit = 100): Promise<string[]> {
    const rows = await manager.getRepository(ReservationEntity).find({
      where: { status: ReservationStatus.HELD, expiresAt: LessThan(new Date()) },
      take: limit,
    });

    return [...new Set(rows.map((r) => r.orderId))];
  }

  findByOrder(manager: EntityManager, orderId: string): Promise<ReservationEntity[]> {
    return manager.getRepository(ReservationEntity).find({ where: { orderId } });
  }
}
