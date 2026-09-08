import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CouponEntity } from '../src/modules/coupons/coupon.entity';
import { CouponRedemptionEntity } from '../src/modules/coupons/coupon-redemption.entity';
import { DiscountEntity } from '../src/modules/pricing/discount.entity';
import { TaxRateEntity } from '../src/modules/pricing/tax-rate.entity';
import { CouponsService } from '../src/modules/coupons/coupons.service';

/**
 * M9's acceptance criterion, and the only test in this project that needs real
 * concurrency against a real database.
 *
 *   50 parallel redemptions of a 10-use coupon yield exactly 10.
 *
 * A unit test cannot prove this. Mocks do not race, and a loop is not
 * concurrency — the bug only appears when several transactions are genuinely
 * in flight against the same row at the same moment.
 *
 * ## Running it
 *
 * It needs Postgres, so it **skips itself** unless one is provided. That keeps
 * `npm run test:all` green and database-free, the same reason the Playwright
 * suite is not in CI.
 *
 *   docker run -d --name coupon-test -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=coupontest -p 15433:5432 postgres:16-alpine
 *
 *   COUPON_TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:15433/coupontest \
 *     npm test --prefix apps/pricing-service
 *
 * It talks to `CouponsService` directly rather than over HTTP. That is
 * deliberate: 50 parallel HTTP requests would also be testing the gateway's
 * rate limiter, which in M8 produced failures that looked exactly like
 * concurrency bugs and cost hours. The contention being measured is on a
 * database row, so that is where the test applies pressure.
 *
 * ## What it asserts
 *
 * Not just the count. The real invariant is that the counter agrees with
 * reality:
 *
 *   used_count === number of non-released redemption rows
 *
 * A count-only assertion misses the failure mode where the counter drifts away
 * from the rows — which is exactly what the naive implementation does, and
 * exactly the bug that had been sitting in inventory since M3.
 */

const DATABASE_URL = process.env.COUPON_TEST_DATABASE_URL;
const PARALLEL = 50;
const MAX_USES = 10;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('coupon redemption under concurrency', () => {
  let dataSource: DataSource;
  let service: CouponsService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [TaxRateEntity, DiscountEntity, CouponEntity, CouponRedemptionEntity],
      migrations: [__dirname + '/../src/database/migrations/*.ts'],
      synchronize: false,
      logging: false,
    });

    await dataSource.initialize();
    await dataSource.runMigrations();
    service = new CouponsService(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  /** A fresh coupon per run, so one scenario cannot contaminate the next. */
  async function freshCoupon(maxUses: number | null, perCustomerLimit: number | null = null) {
    const code = `RACE${randomUUID().slice(0, 8).toUpperCase()}`;

    const [discount] = await dataSource.query(
      `INSERT INTO discounts (name, code, type, value_bp, scope, min_subtotal_minor, active)
       VALUES ($1, $1, 'percentage', 1000, 'order', 0, true) RETURNING id`,
      [code],
    );
    const [coupon] = await dataSource.query(
      `INSERT INTO coupons (code, discount_id, max_uses, per_customer_limit, used_count, active)
       VALUES ($1, $2, $3, $4, 0, true) RETURNING id`,
      [code, discount.id, maxUses, perCustomerLimit],
    );

    return { code, couponId: coupon.id };
  }

  async function stateOf(couponId: string) {
    const [counter] = await dataSource.query(`SELECT used_count FROM coupons WHERE id = $1`, [
      couponId,
    ]);
    const [rows] = await dataSource.query(
      `SELECT count(*)::int AS n FROM coupon_redemptions
        WHERE coupon_id = $1 AND status <> 'released'`,
      [couponId],
    );
    return { usedCount: counter.used_count as number, redemptions: rows.n as number };
  }

  /** Fire `PARALLEL` holds at once, each as its own customer and order. */
  async function stampede(code: string) {
    const attempts = Array.from({ length: PARALLEL }, () =>
      service
        .hold({
          code,
          orderId: randomUUID(),
          customerId: randomUUID(),
          amountMinor: 100,
        })
        .catch((error) => ({ ok: false as const, reason: String(error) })),
    );

    const results = await Promise.all(attempts);
    return {
      granted: results.filter((r) => r.ok).length,
      refused: results.filter((r) => !r.ok).length,
    };
  }

  it(`gives out at most ${MAX_USES} uses when ${PARALLEL} people redeem at once`, async () => {
    const { code, couponId } = await freshCoupon(MAX_USES);

    const { granted, refused } = await stampede(code);
    const state = await stateOf(couponId);

    // eslint-disable-next-line no-console
    console.log(
      `\n  ${PARALLEL} parallel redemptions of a ${MAX_USES}-use coupon:\n` +
        `    granted        ${granted}\n` +
        `    refused        ${refused}\n` +
        `    used_count     ${state.usedCount}\n` +
        `    redemption rows ${state.redemptions}\n`,
    );

    expect(granted + refused).toBe(PARALLEL);
    expect(granted).toBe(MAX_USES);
    expect(state.redemptions).toBe(MAX_USES);
    // The invariant that matters: the counter agrees with reality.
    expect(state.usedCount).toBe(state.redemptions);
  }, 60_000);

  it('holds the line across repeated stampedes — one green run proves nothing', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const { code, couponId } = await freshCoupon(MAX_USES);
      const { granted } = await stampede(code);
      const state = await stateOf(couponId);

      expect({ round, granted, ...state }).toEqual({
        round,
        granted: MAX_USES,
        usedCount: MAX_USES,
        redemptions: MAX_USES,
      });
    }
  }, 120_000);

  it('an unlimited coupon grants every attempt, and still counts them all', async () => {
    const { code, couponId } = await freshCoupon(null);

    const { granted } = await stampede(code);
    const state = await stateOf(couponId);

    expect(granted).toBe(PARALLEL);
    expect(state.redemptions).toBe(PARALLEL);
    expect(state.usedCount).toBe(state.redemptions);
  }, 60_000);

  it('releasing a hold returns the use, and running it twice returns it once', async () => {
    const { code, couponId } = await freshCoupon(1);
    const orderId = randomUUID();

    const held = await service.hold({ code, orderId, customerId: randomUUID(), amountMinor: 100 });
    expect(held.ok).toBe(true);
    expect((await stateOf(couponId)).usedCount).toBe(1);

    expect(await service.release(orderId)).toBe(true);
    expect(await stateOf(couponId)).toEqual({ usedCount: 0, redemptions: 0 });

    // Idempotent: a redelivered cancellation must not credit a second use.
    expect(await service.release(orderId)).toBe(false);
    expect((await stateOf(couponId)).usedCount).toBe(0);
  }, 30_000);

  it('the same order redeeming twice claims one use, not two', async () => {
    const { code, couponId } = await freshCoupon(MAX_USES);
    const orderId = randomUUID();
    const customerId = randomUUID();

    const first = await service.hold({ code, orderId, customerId, amountMinor: 100 });
    const replay = await service.hold({ code, orderId, customerId, amountMinor: 100 });

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: false, reason: 'already_redeemed' });
    expect((await stateOf(couponId)).redemptions).toBe(1);
  }, 30_000);
});
