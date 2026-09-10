import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * shipping-service joins the event system.
 *
 * Both halves earn their place here, which is the first time in this project
 * that has been true on arrival:
 *
 *   processed_events  — a shipment is created by consuming `order.confirmed`,
 *                       over a bus that delivers at least once. Without the
 *                       marker a redelivery is a second parcel.
 *   outbox            — the lifecycle publishes `shipment.dispatched` and
 *                       `shipment.delivered` in the same transaction as the
 *                       status change, so a dispatch that commits cannot fail
 *                       to be announced.
 *
 * cart-service (M7) and pricing-service (M9) both took the outbox before they
 * had anything to publish, and said so. This one is used from the same commit.
 */
export class CreateOutboxTables1735004500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await queryRunner.createTable(
      new Table({
        name: 'outbox',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          // Unique so a republish of the same logical event cannot produce two
          // ids, which would defeat consumer-side deduplication.
          { name: 'event_id', type: 'uuid', isUnique: true },
          { name: 'event_type', type: 'varchar' },
          { name: 'aggregate_id', type: 'uuid' },
          { name: 'correlation_id', type: 'varchar', isNullable: true },
          { name: 'version', type: 'integer', default: 1 },
          { name: 'payload', type: 'jsonb' },
          { name: 'published_at', type: 'timestamptz', isNullable: true },
          { name: 'attempts', type: 'integer', default: 0 },
          { name: 'last_error', type: 'text', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    // The relay's only query is "unpublished, oldest first".
    await queryRunner.createIndex(
      'outbox',
      new TableIndex({
        name: 'IDX_outbox_unpublished',
        columnNames: ['published_at', 'created_at'],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'processed_events',
        columns: [
          // Composite key: the same event may legitimately be handled by more
          // than one consumer, but each consumer only once.
          { name: 'event_id', type: 'uuid', isPrimary: true },
          { name: 'consumer', type: 'varchar', isPrimary: true },
          { name: 'processed_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('processed_events');
    await queryRunner.dropIndex('outbox', 'IDX_outbox_unpublished');
    await queryRunner.dropTable('outbox');
  }
}
