import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateReservationsTable1735000700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'reservations',
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
          { name: 'qty', type: 'integer' },
          {
            name: 'status',
            type: 'enum',
            enum: ['held', 'committed', 'released', 'expired'],
            default: `'held'`,
          },
          { name: 'expires_at', type: 'timestamptz' },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [{ name: 'CHK_reservations_qty_positive', expression: '"qty" > 0' }],
      }),
    );

    // One reservation per product per order. This is what makes a redelivered
    // order.created harmless: the second attempt violates the constraint
    // instead of reserving the stock twice.
    await queryRunner.createIndex(
      'reservations',
      new TableIndex({
        name: 'UQ_reservations_order_product',
        columnNames: ['order_id', 'product_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'reservations',
      new TableIndex({ name: 'IDX_reservations_order_id', columnNames: ['order_id'] }),
    );

    // The expiry job's query: held reservations past their deadline.
    await queryRunner.createIndex(
      'reservations',
      new TableIndex({
        name: 'IDX_reservations_expiry',
        columnNames: ['status', 'expires_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('reservations', 'IDX_reservations_expiry');
    await queryRunner.dropIndex('reservations', 'IDX_reservations_order_id');
    await queryRunner.dropIndex('reservations', 'UQ_reservations_order_product');
    await queryRunner.dropTable('reservations');
  }
}
