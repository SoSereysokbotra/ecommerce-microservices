import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateOrdersTables1735000300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await queryRunner.createTable(
      new Table({
        name: 'orders',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'customer_id', type: 'uuid' },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'confirmed', 'failed'],
            default: `'pending'`,
          },
          { name: 'currency', type: 'char', length: '3' },
          { name: 'total_minor', type: 'integer', default: 0 },
          { name: 'failure_reason', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createIndex(
      'orders',
      new TableIndex({ name: 'IDX_orders_customer_id', columnNames: ['customer_id'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'order_items',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'order_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
          // sku, name and price are copied at purchase time: an order records
          // what was bought at the price agreed, and must not change when the
          // catalog does.
          { name: 'sku', type: 'varchar' },
          { name: 'name', type: 'varchar' },
          { name: 'qty', type: 'integer' },
          { name: 'unit_price_minor', type: 'integer' },
        ],
        checks: [{ name: 'CHK_order_items_qty_positive', expression: '"qty" > 0' }],
      }),
    );

    // Items belong to their order and live in the same database, so a real
    // foreign key is appropriate here — unlike product_id, which points into
    // another service.
    await queryRunner.createForeignKey(
      'order_items',
      new TableForeignKey({
        name: 'FK_order_items_order_id',
        columnNames: ['order_id'],
        referencedTableName: 'orders',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropForeignKey('order_items', 'FK_order_items_order_id');
    await queryRunner.dropTable('order_items');
    await queryRunner.dropIndex('orders', 'IDX_orders_customer_id');
    await queryRunner.dropTable('orders');
  }
}
