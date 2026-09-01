import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateOrderSagaTable1735000800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'order_saga',
        columns: [
          // One saga per order, enforced by the primary key rather than by
          // convention: a second saga for the same order would double-charge.
          { name: 'order_id', type: 'uuid', isPrimary: true },
          {
            name: 'current_step',
            type: 'enum',
            enum: [
              'awaiting_reservation',
              'awaiting_payment',
              'awaiting_commit',
              'awaiting_refund',
              'awaiting_release',
              'done',
            ],
          },
          {
            name: 'outcome',
            type: 'enum',
            enum: ['running', 'completed', 'compensated'],
            default: `'running'`,
          },
          { name: 'compensating', type: 'boolean', default: false },
          { name: 'last_error', type: 'text', isNullable: true },
          { name: 'attempts', type: 'integer', default: 0 },
          { name: 'correlation_id', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    // Startup resume asks exactly this: which sagas are still running?
    await queryRunner.createIndex(
      'order_saga',
      new TableIndex({ name: 'IDX_order_saga_live', columnNames: ['outcome', 'updated_at'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('order_saga', 'IDX_order_saga_live');
    await queryRunner.dropTable('order_saga');
  }
}
