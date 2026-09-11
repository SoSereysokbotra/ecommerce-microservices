import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M11: the exchange rate an order was priced at, frozen onto it.
 *
 * `orders.currency` has existed since M2 and says what the customer was charged
 * in. It does not say what the catalog priced the goods in, or at what rate the
 * one became the other — so a euro order was, until now, a number with no
 * derivation.
 *
 * This is the plan entry's "watch for" made structural:
 *
 * > historical orders must never re-price when rates change
 *
 * They cannot, because nothing re-reads `fx_rates` to display an order. That is
 * the same guarantee M8 gave tax and M10 gave shipping, and the third time this
 * project has reached for it — the figures are stored, never recomputed. These
 * columns add the *audit*: with the rate and the moment it was observed, a
 * disputed total can be reconstructed rather than merely trusted.
 *
 * ## Nullable, not defaulted to parity
 *
 * `fx_rate_e8` could default to 100000000 and mean "1.0". It does not, because
 * **null means "placed before M11"** — a different fact from "placed in the base
 * currency at parity". M8 and M10 both drew that distinction and it has been
 * useful both times: it is what let the M10 audit account for all 114 orders
 * and find the single one that fell in a gap.
 */
export class AddOrderFxRate1735004900000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('orders', [
      new TableColumn({
        name: 'base_currency',
        type: 'char',
        length: '3',
        isNullable: true,
      }),
      // bigint: a rate at 1e8 scale is already past what an integer holds.
      new TableColumn({ name: 'fx_rate_e8', type: 'bigint', isNullable: true }),
      new TableColumn({ name: 'fx_rate_at', type: 'timestamptz', isNullable: true }),
    ]);

    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_fx_rate_positive" ` +
        `CHECK ("fx_rate_e8" IS NULL OR "fx_rate_e8" > 0)`,
    );

    /**
     * The three columns travel together or not at all.
     *
     * A rate with no base currency cannot be interpreted, and a base currency
     * with no rate cannot be applied. Half-populated is not a state this order
     * can be in, so the database refuses it rather than leaving somebody to
     * discover it during a dispute.
     */
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_fx_all_or_nothing" ` +
        `CHECK (("base_currency" IS NULL AND "fx_rate_e8" IS NULL AND "fx_rate_at" IS NULL) ` +
        `OR ("base_currency" IS NOT NULL AND "fx_rate_e8" IS NOT NULL AND "fx_rate_at" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_fx_all_or_nothing"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_fx_rate_positive"`);
    await queryRunner.dropColumns('orders', ['base_currency', 'fx_rate_e8', 'fx_rate_at']);
  }
}
