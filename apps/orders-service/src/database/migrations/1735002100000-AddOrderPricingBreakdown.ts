import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M8: an order stops storing one number and starts storing the whole quote.
 *
 * `total_minor` keeps its meaning — it is still the amount charged, and still
 * what `payment.requested` carries to Stripe. What is new is everything that
 * explains it: what the basket came to before anything was applied, what came
 * off, what tax was added, and which jurisdiction decided that.
 *
 * **Every new money column defaults to 0 and the two destination columns are
 * nullable**, which is what makes this safe over the orders already in the
 * database. A pre-M8 order then reads as "no discount, no tax, taxed nowhere",
 * which is exactly what it was — no backfill required, and no row changes
 * meaning.
 *
 * The breakdown is *frozen* here rather than recomputed on read. `order_items`
 * already copies sku, name and price at purchase time because an order is a
 * record of what was bought at a price the customer agreed to; tax and discount
 * are the same kind of fact. Change a rate tomorrow and every historical order
 * is unaffected, because nothing re-reads `tax_rates` to display one.
 */
export class AddOrderPricingBreakdown1735002100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('orders', [
      new TableColumn({
        name: 'subtotal_minor',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
      new TableColumn({
        name: 'discount_minor',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
      new TableColumn({ name: 'tax_minor', type: 'integer', isNullable: false, default: 0 }),
      // Where this order was taxed, recorded so a historical order shows the
      // jurisdiction it was priced for. Nullable because orders placed before
      // M8 were taxed nowhere, and 'unknown' is the honest value for them.
      new TableColumn({ name: 'tax_country', type: 'char', length: '2', isNullable: true }),
      new TableColumn({ name: 'tax_region', type: 'varchar', isNullable: true }),
    ]);

    await queryRunner.addColumns('order_items', [
      new TableColumn({
        name: 'line_discount_minor',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
      // Basis points, matching pricing-service: 725 is 7.25%.
      new TableColumn({ name: 'tax_rate_bp', type: 'integer', isNullable: false, default: 0 }),
      // This line's share of its tax group's single rounded figure — never an
      // independently rounded number. See pricing-service's quote.ts.
      new TableColumn({ name: 'tax_minor', type: 'integer', isNullable: false, default: 0 }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('order_items', [
      'line_discount_minor',
      'tax_rate_bp',
      'tax_minor',
    ]);
    await queryRunner.dropColumns('orders', [
      'subtotal_minor',
      'discount_minor',
      'tax_minor',
      'tax_country',
      'tax_region',
    ]);
  }
}
