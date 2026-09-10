import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * M10: the address book.
 *
 * It lives here rather than in shipping-service, which is what
 * `IMPLEMENTATION_PLAN.md` §3 says — see docs/M10_SHIPPING_PLAN.md §3 for the
 * argument. In short: an address book is a **profile** concern. It belongs to a
 * customer, it is edited on an account page, it outlives every order, and the
 * next things that want it (order confirmation emails in M15, an admin's
 * customer view in M17) are not shipping concerns either.
 *
 * shipping-service never reads this table. It needs a *destination* to pick a
 * zone, and the **order** carries a frozen snapshot so a parcel's label does not
 * change when the customer edits their address next year.
 */
export class CreateCustomerAddresses1735004300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'customer_addresses',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'user_id', type: 'uuid' },
          { name: 'label', type: 'varchar', isNullable: true },
          { name: 'recipient', type: 'varchar' },
          { name: 'line1', type: 'varchar' },
          { name: 'line2', type: 'varchar', isNullable: true },
          { name: 'city', type: 'varchar' },
          // Feeds the tax destination *and* the shipping zone. Nullable because
          // most countries have nothing a shopper would recognise as a state.
          { name: 'region', type: 'varchar', isNullable: true },
          { name: 'postcode', type: 'varchar', isNullable: true },
          { name: 'country', type: 'char', length: '2' },
          { name: 'phone', type: 'varchar', isNullable: true },
          { name: 'is_default', type: 'boolean', default: false },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          // Two letters, upper case. A three-letter code or a country *name*
          // here silently matches no tax rule and no shipping zone, which shows
          // up as a wrong total rather than as an error — so reject it at the
          // column, the way this project has done since M8's stock constraint.
          {
            name: 'CHK_customer_addresses_country_iso2',
            expression: `"country" ~ '^[A-Z]{2}$'`,
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'customer_addresses',
      new TableForeignKey({
        name: 'FK_customer_addresses_user',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        // An address has no meaning without its owner, and an order that used
        // one kept its own frozen copy — so nothing is lost by cascading.
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'customer_addresses',
      new TableIndex({
        name: 'IDX_customer_addresses_user',
        columnNames: ['user_id'],
      }),
    );

    /**
     * At most one default per customer, enforced by the database.
     *
     * A partial unique index rather than application code, because "make this
     * one the default" is two writes — clear the old, set the new — and a
     * crash between them leaves either none (harmless) or two (a checkout that
     * picks an arbitrary address). Postgres will not allow the second.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_addresses_one_default"
         ON "customer_addresses" ("user_id") WHERE "is_default"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_customer_addresses_one_default"`);
    await queryRunner.dropIndex('customer_addresses', 'IDX_customer_addresses_user');
    await queryRunner.dropForeignKey('customer_addresses', 'FK_customer_addresses_user');
    await queryRunner.dropTable('customer_addresses');
  }
}
