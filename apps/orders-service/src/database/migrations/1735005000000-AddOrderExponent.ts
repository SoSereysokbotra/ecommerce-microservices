import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M11: how to read every other number on the order.
 *
 * `total_minor = 3815` means ¥3815 or $38.15 depending on a fact stored
 * nowhere on this row. Until M11 that fact was a constant — two — and the
 * codebase divided by 100 without asking. It is not a constant.
 *
 * ## It earns its place twice
 *
 * 1. **The storefront** formats an order from what the order says. Looking the
 *    exponent up from pricing at render time would make displaying a historical
 *    order depend on a table that can change, which is the exact coupling the
 *    rest of this row exists to avoid.
 * 2. **payments** compares it against Stripe's own minor-unit convention before
 *    creating an intent. Stripe is handed `amount_minor` directly, so the charge
 *    is correct only if our exponent agrees with theirs — and a disagreement is
 *    a 100× error on the one operation in this project that moves real money.
 *    Two independent sources for the same fact, compared before the money does.
 *
 * Nullable, and null means "placed before M11" — the same distinction the
 * three FX columns draw. A reader of an old row should assume two, and should
 * have to decide that rather than be told it silently.
 */
export class AddOrderExponent1735005000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'orders',
      new TableColumn({ name: 'exponent', type: 'smallint', isNullable: true }),
    );

    // Same range as `currencies.exponent`, and for the same reason: outside it
    // is a typo, and a typo here is charged to somebody.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_exponent_range" ` +
        `CHECK ("exponent" IS NULL OR "exponent" BETWEEN 0 AND 4)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_exponent_range"`);
    await queryRunner.dropColumn('orders', 'exponent');
  }
}
