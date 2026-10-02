import { MigrationInterface, QueryRunner, Table, TableIndex, TableUnique } from 'typeorm';

/**
 * The three tables M13 owns.
 *
 * `purchases` is written only by the `order.confirmed` consumer; `reviews` by
 * requests; `product_ratings` by the moderation transaction. No foreign keys
 * to anything outside this database — product ids and customer ids belong to
 * catalog and users, and a service that enforced them here would be reading
 * another service's tables.
 */
export class CreateReviewTables1735006100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'purchases',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'customer_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
          { name: 'order_id', type: 'uuid' },
          { name: 'sku', type: 'varchar' },
          { name: 'qty', type: 'integer' },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
        uniques: [
          // What makes a republished order.confirmed (new event id, which the
          // processed_events marker cannot catch) harmless.
          new TableUnique({
            name: 'UQ_purchases_customer_product_order',
            columnNames: ['customer_id', 'product_id', 'order_id'],
          }),
        ],
      }),
    );

    // The eligibility read: "has this customer bought this product?"
    await queryRunner.createIndex(
      'purchases',
      new TableIndex({
        name: 'IDX_purchases_customer_product',
        columnNames: ['customer_id', 'product_id'],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'reviews',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'product_id', type: 'uuid' },
          { name: 'customer_id', type: 'uuid' },
          { name: 'order_id', type: 'uuid' },
          { name: 'rating', type: 'integer' },
          { name: 'title', type: 'varchar', length: '120' },
          { name: 'body', type: 'text' },
          { name: 'author_name', type: 'varchar' },
          { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
          { name: 'moderated_at', type: 'timestamptz', isNullable: true },
          { name: 'moderation_note', type: 'text', isNullable: true },
          { name: 'version', type: 'integer', default: 1 },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        uniques: [
          new TableUnique({
            name: 'UQ_reviews_product_customer',
            columnNames: ['product_id', 'customer_id'],
          }),
        ],
        checks: [
          // The scale, enforced where it cannot be bypassed. A DTO validates
          // the request; this validates the table.
          { name: 'CHK_reviews_rating_range', expression: 'rating BETWEEN 1 AND 5' },
          {
            name: 'CHK_reviews_status',
            expression: "status IN ('pending', 'approved', 'rejected')",
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'reviews',
      new TableIndex({
        name: 'IDX_reviews_product_status',
        columnNames: ['product_id', 'status'],
      }),
    );

    await queryRunner.createIndex(
      'reviews',
      new TableIndex({
        name: 'IDX_reviews_status_created',
        columnNames: ['status', 'created_at'],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'product_ratings',
        columns: [
          { name: 'product_id', type: 'uuid', isPrimary: true },
          { name: 'rating_sum', type: 'integer', default: 0 },
          { name: 'rating_count', type: 'integer', default: 0 },
          { name: 'version', type: 'integer', default: 0 },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          // A count or sum that went negative would mean the rollup had drifted
          // from the reviews it summarises. Fail the transaction instead.
          {
            name: 'CHK_product_ratings_nonneg',
            expression: 'rating_sum >= 0 AND rating_count >= 0',
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('product_ratings');
    await queryRunner.dropIndex('reviews', 'IDX_reviews_status_created');
    await queryRunner.dropIndex('reviews', 'IDX_reviews_product_status');
    await queryRunner.dropTable('reviews');
    await queryRunner.dropIndex('purchases', 'IDX_purchases_customer_product');
    await queryRunner.dropTable('purchases');
  }
}
