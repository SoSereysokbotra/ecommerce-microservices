import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateStockTable1735000200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'stock',
        columns: [
          // product_id is the primary key: exactly one stock row per product,
          // enforced by the database rather than by convention.
          { name: 'product_id', type: 'uuid', isPrimary: true },
          { name: 'available_qty', type: 'integer', default: 0 },
          { name: 'reserved_qty', type: 'integer', default: 0 },
          { name: 'version', type: 'integer', default: 1 },
          { name: 'updated_at', type: 'timestamp', default: 'now()' },
        ],
        checks: [
          // Stock can never go negative. The service checks this too, but a
          // constraint is what survives a bug in the service.
          { name: 'CHK_stock_available_non_negative', expression: '"available_qty" >= 0' },
          { name: 'CHK_stock_reserved_non_negative', expression: '"reserved_qty" >= 0' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('stock');
  }
}
