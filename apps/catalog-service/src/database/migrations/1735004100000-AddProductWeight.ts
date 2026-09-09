import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M10: how much a product weighs.
 *
 * Nothing in this project knew this until now, and "rate calculation by
 * weight/zone" is unbuildable without it — shipping-service can band a parcel
 * perfectly and still have nothing to band.
 *
 * ## Why the default is 0 and the column is NOT NULL
 *
 * The same choice M8 made when it added the pricing breakdown to `orders`: add
 * columns with safe defaults so every existing row stays valid. Twelve seeded
 * products and any product created before this migration get 0g, which
 * `selectBand` puts in the lightest band — so an unweighed product **ships**
 * rather than failing a quote. A nullable column would push that decision into
 * every reader, and the first reader to forget would quote `NaN`.
 *
 * ## Why grams, as an integer
 *
 * The same discipline as minor units, for the same reason: this number gets
 * compared against band boundaries and decides what a customer is charged, and
 * binary floating point cannot represent most decimal fractions exactly. There
 * is no float anywhere in the pricing path and there will not be one here.
 *
 * Volumetric/dimensional weight — where a large light parcel is charged as if
 * it were heavier — is a real thing and deliberately out of scope. It needs
 * three more columns and a second rating rule; noted in ADR-0009.
 */
export class AddProductWeight1735004100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'products',
      new TableColumn({
        name: 'weight_grams',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
    );

    // A negative weight would select the lightest band by accident rather than
    // failing, which is the quiet kind of wrong this project keeps choosing to
    // make loud. Same reasoning as CHK_shipping_rates_price_non_negative.
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "CHK_products_weight_non_negative" CHECK ("weight_grams" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "CHK_products_weight_non_negative"`,
    );
    await queryRunner.dropColumn('products', 'weight_grams');
  }
}
