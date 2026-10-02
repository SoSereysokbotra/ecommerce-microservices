import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * reviews-service joins the event system, on arrival.
 *
 * Both halves earn their place from the first commit, as shipping-service's
 * did and unlike cart (M7) and pricing (M9), which took the outbox before
 * they had anything to publish:
 *
 *   processed_events  — `order.confirmed` creates purchase rows over a bus
 *                       that delivers at least once.
 *   outbox            — `product.rating_changed` is published in the same
 *                       transaction as the moderation decision that moved
 *                       the rollup, so an approval that commits cannot fail
 *                       to be announced.
 *
 * Byte-identical to shipping-service's, deliberately: one pattern, one shape.
 */
export class CreateOutboxTables1735006000000 implements MigrationInterface {
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
