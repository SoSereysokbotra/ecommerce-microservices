import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Recommendations co-purchase table.
 *
 * Stores symmetric directed rows per M14 plan §6 (Alternative 2):
 * A confirmed order containing products A and B writes both (A, B) and (B, A).
 * Read query scans (product_id, co_purchase_count DESC) with limit.
 *
 * Check constraints enforce:
 * - product_id <> recommended_product_id (no self-recommendations)
 * - co_purchase_count >= 0 (non-negative count accumulator)
 */
export class CreateRecommendations1735007100000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'product_recommendations',
        columns: [
          {
            name: 'product_id',
            type: 'uuid',
            isPrimary: true,
          },
          {
            name: 'recommended_product_id',
            type: 'uuid',
            isPrimary: true,
          },
          {
            name: 'co_purchase_count',
            type: 'integer',
            default: 0,
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'CHK_product_recommendations_distinct',
            expression: '"product_id" <> "recommended_product_id"',
          },
          {
            name: 'CHK_product_recommendations_count_nonneg',
            expression: '"co_purchase_count" >= 0',
          },
        ],
      }),
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_product_recommendations_lookup"
         ON "product_recommendations" ("product_id", "co_purchase_count" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_product_recommendations_lookup"`);
    await queryRunner.dropTable('product_recommendations');
  }
}
