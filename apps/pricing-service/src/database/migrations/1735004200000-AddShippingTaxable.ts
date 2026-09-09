import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M10: whether a jurisdiction taxes delivery.
 *
 * The question nobody asks until an accountant does, and the answers are
 * genuinely different in a way that is not guessable:
 *
 *   California    does **not** tax separately-stated delivery by common carrier.
 *   Pennsylvania  **does** tax delivery when the goods are taxable.
 *   Germany       treats delivery as ancillary to the supply: it carries the
 *                 goods' VAT rate, and the price shown already includes it.
 *
 * So this cannot be a constant, and it cannot be derived from the rate. It is a
 * property of the rule, and it lives on the row that already carries the rate
 * and the inclusive/exclusive convention for that jurisdiction.
 *
 * Only the **general** rule for a destination is consulted — the one with
 * `category IS NULL` — because delivery has no product category. A category
 * exemption (Pennsylvania's clothing rule) says nothing about postage.
 *
 * Default `true`, because the exclusive-tax default in this table is the
 * commoner case and an untaxed-by-accident shipping line under-collects, which
 * is the direction that is a problem rather than merely wrong.
 */
export class AddShippingTaxable1735004200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'tax_rates',
      new TableColumn({
        name: 'shipping_taxable',
        type: 'boolean',
        isNullable: false,
        default: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('tax_rates', 'shipping_taxable');
  }
}
