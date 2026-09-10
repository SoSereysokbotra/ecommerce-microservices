import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M10: what delivery cost, and where it is going — frozen onto the order.
 *
 * ## What this fixes
 *
 * Step 5 folded shipping into `POST /pricing/quote`, so from that commit an
 * order's `total_minor` already **included** delivery and the customer was
 * charged the right amount. But the order's own columns did not add up:
 * `subtotal − discount + tax` fell short of `total` by exactly the postage,
 * with nothing to say so. The order could not explain its own total. These
 * three columns are that explanation.
 *
 * ## Safe defaults, as M8 did
 *
 * `shipping_minor` defaults to 0 and the other two are nullable, so every order
 * placed before M10 stays valid and reads as "no shipping recorded" rather than
 * becoming a row that needs interpreting. Orders placed between step 5 and this
 * migration are the one awkward set: their totals include delivery but their
 * `shipping_minor` will read 0. There are only the test orders from step 5's
 * verification, and no attempt is made to reconstruct them — a guessed
 * breakdown is worse than an honest zero.
 *
 * ## Why the address is jsonb
 *
 * It is a frozen document, never queried by field, and normalising it would be
 * normalising a copy. The live address lives in users-service and may be
 * edited or deleted; this is what was agreed at checkout, on the same footing
 * as `order_items.sku` and `order_items.unit_price_minor`.
 */
export class AddOrderShipping1735004400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('orders', [
      new TableColumn({
        name: 'shipping_minor',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
      new TableColumn({
        name: 'shipping_rate_code',
        type: 'varchar',
        isNullable: true,
      }),
      new TableColumn({
        name: 'shipping_address',
        type: 'jsonb',
        isNullable: true,
      }),
    ]);

    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_shipping_non_negative" CHECK ("shipping_minor" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_shipping_non_negative"`,
    );
    await queryRunner.dropColumns('orders', [
      'shipping_minor',
      'shipping_rate_code',
      'shipping_address',
    ]);
  }
}
