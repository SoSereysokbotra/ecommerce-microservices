import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreatePricingTables1735002000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'tax_rates',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'country', type: 'char', length: '2' },
          { name: 'region', type: 'varchar', isNullable: true },
          { name: 'category', type: 'varchar', isNullable: true },
          { name: 'rate_bp', type: 'integer' },
          { name: 'prices_include_tax', type: 'boolean', default: false },
          { name: 'name', type: 'varchar' },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          // A negative rate is not a discount, it is a bug. Discounts have
          // their own table.
          { name: 'CHK_tax_rates_rate_non_negative', expression: '"rate_bp" >= 0' },
        ],
      }),
    );

    // One rule per scope.
    //
    // This cannot be a plain UNIQUE (country, region, category): in SQL two
    // NULLs are not equal, so `('US', NULL, NULL)` could be inserted twice and
    // the resolver would silently pick whichever row it saw first. Here NULL is
    // not "unknown", it is "matches everything" — a real value — so the index
    // coalesces it to a sentinel the comparison can see.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_tax_rates_scope"
      ON "tax_rates" ("country", COALESCE("region", '*'), COALESCE("category", '*'))
    `);

    // The resolver's lookup: every rule for one country, filtered in memory.
    await queryRunner.query(`CREATE INDEX "IDX_tax_rates_country" ON "tax_rates" ("country")`);

    await queryRunner.query(`CREATE TYPE "discount_type_enum" AS ENUM ('percentage', 'fixed')`);
    await queryRunner.query(
      `CREATE TYPE "discount_scope_enum" AS ENUM ('order', 'category', 'product')`,
    );

    await queryRunner.createTable(
      new Table({
        name: 'discounts',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          // Always NULL in M8. M9 owns coupon codes and everything they need.
          { name: 'code', type: 'varchar', isNullable: true },
          { name: 'name', type: 'varchar', isUnique: true },
          { name: 'type', type: 'discount_type_enum' },
          { name: 'value_bp', type: 'integer', isNullable: true },
          { name: 'value_minor', type: 'integer', isNullable: true },
          { name: 'scope', type: 'discount_scope_enum', default: `'order'` },
          { name: 'scope_ref', type: 'varchar', isNullable: true },
          { name: 'min_subtotal_minor', type: 'integer', default: 0 },
          { name: 'starts_at', type: 'timestamptz', isNullable: true },
          { name: 'ends_at', type: 'timestamptz', isNullable: true },
          { name: 'active', type: 'boolean', default: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          // A percentage discount carries value_bp, a fixed one value_minor,
          // and never both or neither. Enforced here rather than trusted from
          // the caller, following the precedent set by cart_items' qty check:
          // a row that violates this would make the calculator silently
          // discount nothing.
          {
            name: 'CHK_discounts_value_exactly_one',
            expression: '("value_bp" IS NULL) <> ("value_minor" IS NULL)',
          },
          {
            name: 'CHK_discounts_value_non_negative',
            expression:
              'COALESCE("value_bp", 0) >= 0 AND COALESCE("value_minor", 0) >= 0 AND "min_subtotal_minor" >= 0',
          },
          // An order-wide promotion has nothing to point at; a category or
          // product one is meaningless without it.
          {
            name: 'CHK_discounts_scope_ref',
            expression: `("scope" = 'order') = ("scope_ref" IS NULL)`,
          },
          // A window that ends before it starts would never apply, and is
          // more likely a typo than an intention.
          {
            name: 'CHK_discounts_window',
            expression: '"starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" <= "ends_at"',
          },
        ],
      }),
    );

    // The quote's lookup: every promotion that could apply right now.
    await queryRunner.query(`CREATE INDEX "IDX_discounts_active" ON "discounts" ("active")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_discounts_active"`);
    await queryRunner.dropTable('discounts');
    await queryRunner.query(`DROP TYPE "discount_scope_enum"`);
    await queryRunner.query(`DROP TYPE "discount_type_enum"`);
    await queryRunner.query(`DROP INDEX "IDX_tax_rates_country"`);
    await queryRunner.query(`DROP INDEX "UQ_tax_rates_scope"`);
    await queryRunner.dropTable('tax_rates');
  }
}
