import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * M12: a version on every product and category.
 *
 * ## Why the search index needs it
 *
 * The bus delivers at least once and in no guaranteed order, so the projection
 * on the read side will eventually receive `product.updated` v6 *after* v7. A
 * `processed_events` marker cannot help — it says "seen this event id", not
 * "seen a newer one". The version travels on the event and OpenSearch's
 * external versioning refuses a write whose version is not greater than the
 * stored one. Redelivery, republication and reordering, one mechanism.
 *
 * ## The bug it closes on the way
 *
 * Catalog has never had **optimistic locking**. Two staff editing the same
 * product at once produce a lost update, silently — the exact class of defect
 * M8 found in inventory's stock rows. This column is the version the guard
 * needs; the guard itself is a conditional UPDATE in `ProductsService.update()`,
 * because TypeORM's `@VersionColumn` increments on save but does **not** check
 * — a collision test against the first version of this code proved it. Now
 * proved the other way: the stale editor gets a 409.
 *
 * Starts at 1 for every existing row. Version 0 would be indistinguishable from
 * "never versioned" on the read side.
 */
export class AddVersionColumns1735005200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['products', 'categories']) {
      await queryRunner.addColumn(
        table,
        new TableColumn({ name: 'version', type: 'integer', isNullable: false, default: 1 }),
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "CHK_${table}_version_positive" CHECK ("version" >= 1)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['categories', 'products']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "CHK_${table}_version_positive"`,
      );
      await queryRunner.dropColumn(table, 'version');
    }
  }
}
