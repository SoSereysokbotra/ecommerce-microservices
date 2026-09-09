import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CouponEntity } from './coupon.entity';
import { DiscountEntity } from '../pricing/discount.entity';

export type CouponRejection =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'exhausted'
  | 'per_customer_limit'
  | 'already_redeemed';

export interface HoldRequest {
  code: string;
  orderId: string;
  customerId: string;
  amountMinor: number;
}

export type HoldResult =
  { ok: true; couponId: string; amountMinor: number } | { ok: false; reason: CouponRejection };

/**
 * Claiming, spending and returning a coupon use.
 *
 * The lifecycle mirrors an inventory reservation exactly — HELD while the order
 * is only a possibility, COMMITTED when it is paid, RELEASED if it is not —
 * because the problem is the same: a finite resource claimed against an order
 * that may never happen.
 *
 * ## Why `hold()` looks the way it does
 *
 * The obvious implementation reads `used_count`, checks it against `max_uses`,
 * and writes the incremented value back. It is also wrong, and this project has
 * the measurement: with 50 simultaneous redemptions of a **10-use** coupon it
 * granted **50**, and left the counter reading **6** against 50 redemption
 * rows. Every caller read the same stale number, every caller liked it, and 44
 * increments were lost on top of that.
 *
 * Note what the CHECK constraint did *not* do there. `used_count <= max_uses`
 * was never violated, because each writer wrote a small value — the constraint
 * guards the counter, and the counter had stopped describing reality. A
 * constraint catches a wrong *value*; it cannot catch a wrong *read*.
 *
 * So the check and the increment happen in **one statement** no other
 * transaction can interleave with. Postgres serialises concurrent updates to
 * the same row, so `used_count < max_uses` is evaluated against the committed
 * value at the moment of the write rather than against something read earlier.
 * No window, no retry loop, nothing that only misbehaves under load. Fifty
 * attempts yield ten by construction rather than by convergence.
 *
 * `IMPLEMENTATION_PLAN.md` proposed optimistic locking on `coupons.version`
 * instead. That works too, with a retry loop — and the retry loop is the part
 * that is easy to write wrong and hard to prove right, because it only misfires
 * under contention. ADR-0008 records the trade. `version` is kept for what
 * optimistic locking is genuinely good at: edits to the coupon itself.
 */
@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Look a code up and decide whether it *would* apply. Writes nothing.
   *
   * This is what quoting uses, and the distinction from `hold()` is the whole
   * design: a cart page re-quotes on every keystroke, so resolving must be free.
   * The counter is only touched once, by the order.
   *
   * Because it writes nothing, its answer can be stale by the time an order is
   * placed — the last use may go to someone else in between. That is fine and
   * expected: `hold()` is the authority, and it re-checks atomically. This
   * exists to give the shopper a price and a reason, not a guarantee.
   */
  async resolve(
    code: string,
    customerId?: string,
  ): Promise<
    | { ok: true; coupon: { id: string; code: string }; discount: DiscountEntity }
    | { ok: false; reason: CouponRejection }
  > {
    const normalised = code.trim().toUpperCase();

    const coupon = await this.dataSource.getRepository(CouponEntity).findOne({
      where: { code: normalised },
      relations: { discount: true },
    });

    if (!coupon) return { ok: false, reason: 'not_found' };
    if (!coupon.active || !coupon.discount?.active) return { ok: false, reason: 'inactive' };

    const now = new Date();
    if (coupon.startsAt && now < coupon.startsAt) return { ok: false, reason: 'not_started' };
    if (coupon.endsAt && now > coupon.endsAt) return { ok: false, reason: 'expired' };
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      return { ok: false, reason: 'exhausted' };
    }

    if (customerId && coupon.perCustomerLimit !== null) {
      const [{ n }] = await this.dataSource.query(
        `SELECT count(*)::int AS n FROM coupon_redemptions
          WHERE coupon_id = $1 AND customer_id = $2 AND status <> 'released'`,
        [coupon.id, customerId],
      );
      if (n >= coupon.perCustomerLimit) return { ok: false, reason: 'per_customer_limit' };
    }

    return { ok: true, coupon: { id: coupon.id, code: coupon.code }, discount: coupon.discount };
  }

  /**
   * Claim one use of a coupon for an order.
   *
   * Two steps doing two different jobs:
   *
   *   1. A plain read, purely to explain *why* a coupon was refused — unknown
   *      code, inactive, expired, not yet started. Nothing here is load-bearing:
   *      a stale read can only produce a slightly less precise error message.
   *   2. The atomic claim, which is the only authority on whether a use was
   *      actually available.
   *
   * Getting those the wrong way round — trusting step 1's count — is exactly
   * the bug this milestone exists to demonstrate.
   */
  async hold(request: HoldRequest, manager?: EntityManager): Promise<HoldResult> {
    const run = async (m: EntityManager): Promise<HoldResult> => {
      const code = request.code.trim().toUpperCase();

      const rows = await m.query(
        `SELECT id, max_uses, used_count, per_customer_limit, active, starts_at, ends_at
           FROM coupons WHERE code = $1`,
        [code],
      );
      const coupon = rows[0];

      if (!coupon) return { ok: false, reason: 'not_found' };
      if (!coupon.active) return { ok: false, reason: 'inactive' };

      const now = new Date();
      if (coupon.starts_at && now < new Date(coupon.starts_at)) {
        return { ok: false, reason: 'not_started' };
      }
      if (coupon.ends_at && now > new Date(coupon.ends_at)) {
        return { ok: false, reason: 'expired' };
      }

      // Cheap pre-check, for the error message only. The claim below decides.
      if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
        return { ok: false, reason: 'exhausted' };
      }

      /**
       * Per-customer limit, enforced by reading — and therefore **best-effort**.
       * One customer submitting two orders in the same instant could pass this
       * twice. That is a far narrower race than the global one, since it needs
       * the same person racing themselves, and it cannot over-redeem the coupon
       * because the atomic claim below still holds the global line.
       *
       * The exact fix for the common `per_customer_limit = 1` case is a partial
       * unique index on `(coupon_id, customer_id) WHERE status <> 'released'`.
       * Left out deliberately: it does not generalise to limits above 1, and
       * this milestone's criterion is the global count. Recorded in ADR-0008
       * rather than left to be discovered.
       */
      if (coupon.per_customer_limit !== null) {
        const [{ n }] = await m.query(
          `SELECT count(*)::int AS n FROM coupon_redemptions
            WHERE coupon_id = $1 AND customer_id = $2 AND status <> 'released'`,
          [coupon.id, request.customerId],
        );
        if (n >= coupon.per_customer_limit) {
          return { ok: false, reason: 'per_customer_limit' };
        }
      }

      // --- stake the order's claim first ------------------------------------
      // The redemption row goes in before the counter moves, and `ON CONFLICT
      // DO NOTHING` means a redelivered order.created returns zero rows instead
      // of raising.
      //
      // That detail is not cosmetic. Letting the unique violation throw aborts
      // the Postgres transaction outright — "current transaction is aborted,
      // commands ignored until end of transaction block" — so the compensating
      // decrement written to run afterwards could never execute. The first
      // version of this method had exactly that bug, and the replay test caught
      // it. Not raising in the first place is simpler than unwinding.
      const staked = returning(
        await m.query(
          `INSERT INTO coupon_redemptions (coupon_id, order_id, customer_id, status, amount_minor)
           VALUES ($1, $2, $3, 'held', $4)
           ON CONFLICT (order_id) DO NOTHING
           RETURNING id`,
          [coupon.id, request.orderId, request.customerId, request.amountMinor],
        ),
      );

      // This order already holds a use. It must not take a second, and no use
      // has been consumed here, so there is nothing to give back.
      if (staked.length === 0) {
        return { ok: false, reason: 'already_redeemed' };
      }

      // --- the claim --------------------------------------------------------
      // One statement. The condition is evaluated against the committed value
      // at the moment of the write, so it cannot be raced: fifty callers issue
      // this simultaneously and exactly ten of them affect a row.
      const claimed = returning(
        await m.query(
          `UPDATE coupons
              SET used_count = used_count + 1, version = version + 1
            WHERE id = $1
              AND active
              AND (max_uses IS NULL OR used_count < max_uses)
              AND (starts_at IS NULL OR starts_at <= now())
              AND (ends_at IS NULL OR ends_at >= now())
          RETURNING id`,
          [coupon.id],
        ),
      );

      // Zero rows means someone else took the last use between the read above
      // and this statement. Not an error — the mechanism working. Take the
      // staked row back out so a later attempt on a released use is not blocked
      // by a row for an order that never held anything.
      if (claimed.length === 0) {
        await m.query(`DELETE FROM coupon_redemptions WHERE id = $1`, [staked[0].id]);
        return { ok: false, reason: 'exhausted' };
      }

      return { ok: true, couponId: coupon.id, amountMinor: request.amountMinor };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /** The order was confirmed: the use is spent for good. */
  async commit(orderId: string, manager?: EntityManager): Promise<boolean> {
    const run = async (m: EntityManager): Promise<boolean> => {
      const rows = returning(
        await m.query(
          `UPDATE coupon_redemptions SET status = 'committed', updated_at = now()
            WHERE order_id = $1 AND status = 'held' RETURNING id`,
          [orderId],
        ),
      );
      return rows.length > 0;
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * The order was cancelled: the use goes back.
   *
   * Only acts on a HELD row, so running it twice returns the use once — the
   * same idempotence inventory's `release()` relies on, and necessary for the
   * same reason: cancellation arrives over an at-least-once bus.
   */
  async release(orderId: string, manager?: EntityManager): Promise<boolean> {
    const run = async (m: EntityManager): Promise<boolean> => {
      const rows = returning<{ coupon_id: string }>(
        await m.query(
          `UPDATE coupon_redemptions SET status = 'released', updated_at = now()
            WHERE order_id = $1 AND status = 'held' RETURNING coupon_id`,
          [orderId],
        ),
      );

      if (rows.length === 0) return false;

      // Guarded so a decrement can never drive the counter below zero, the way
      // inventory's could before M8 added row locks there.
      await m.query(
        `UPDATE coupons SET used_count = used_count - 1
          WHERE id = $1 AND used_count > 0`,
        [rows[0].coupon_id],
      );

      this.logger.log(`Released coupon hold for order ${orderId}`);
      return true;
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }
}

/**
 * Rows from a `... RETURNING` clause, whatever statement produced them.
 *
 * TypeORM's `query()` is **not consistent** about this, which is worth knowing
 * before it costs an afternoon. Measured against Postgres 16:
 *
 *   SELECT                     -> [{ id }]            plain rows
 *   INSERT ... RETURNING       -> [{ id }]            plain rows
 *   INSERT ... DO NOTHING (0)  -> []                  empty
 *   UPDATE ... RETURNING       -> [[{ id }], 1]       rows AND affected count
 *   UPDATE ... matching none   -> [[], 0]
 *
 * Both mistakes here are silent rather than loud. Assuming the UPDATE shape for
 * everything makes a successful INSERT look like a conflict — every one of 50
 * redemptions was reported "already redeemed" while its row sat in the table.
 * Assuming the plain shape for an UPDATE makes `rows[0].coupon_id` `undefined`,
 * so the follow-up `WHERE id = undefined` matches nothing and a release appears
 * to succeed while returning no use at all. This project has now made both.
 */
function returning<T = Record<string, unknown>>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // UPDATE / DELETE ... RETURNING: rows are nested alongside the row count.
  if (Array.isArray(result[0])) return result[0] as T[];
  // SELECT and INSERT ... RETURNING: already the rows.
  return result as T[];
}
