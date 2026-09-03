import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateCartTables1735001000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'carts',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'customer_id', type: 'uuid', isUnique: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    // The abandonment sweep's query: carts untouched since a cutoff.
    await queryRunner.createIndex(
      'carts',
      new TableIndex({ name: 'IDX_carts_updated_at', columnNames: ['updated_at'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'cart_items',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'cart_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
          { name: 'qty', type: 'integer' },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [{ name: 'CHK_cart_items_qty_positive', expression: '"qty" > 0' }],
      }),
    );

    // One line per product per cart. This is what turns "add the same thing
    // twice" into an update rather than a duplicate row, and it is what the
    // merge relies on when it sums the two carts together.
    await queryRunner.createIndex(
      'cart_items',
      new TableIndex({
        name: 'UQ_cart_items_cart_product',
        columnNames: ['cart_id', 'product_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createForeignKey(
      'cart_items',
      new TableForeignKey({
        name: 'FK_cart_items_cart',
        columnNames: ['cart_id'],
        referencedTableName: 'carts',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropForeignKey('cart_items', 'FK_cart_items_cart');
    await queryRunner.dropIndex('cart_items', 'UQ_cart_items_cart_product');
    await queryRunner.dropTable('cart_items');
    await queryRunner.dropIndex('carts', 'IDX_carts_updated_at');
    await queryRunner.dropTable('carts');
  }
}
