import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * M10: shipping zones and the rate bands inside them.
 *
 * The constraints here are the point of this migration, not the columns. Every
 * one of them was proved by inserting a row that should be rejected, against a
 * throwaway Postgres — the method M9 step 1 established, and the reason M8's
 * lost update in inventory was ever noticed at all.
 *
 * `shipments` is deliberately not here. It arrives with the consumer that
 * creates one, at step 7 of docs/M10_SHIPPING_PLAN.md §13.
 */
export class CreateShippingTables1735004000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'shipping_zones',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'code', type: 'varchar', isUnique: true },
          { name: 'name', type: 'varchar' },
          // Empty array = every country. See ShippingZoneEntity.countries.
          { name: 'countries', type: 'text', isArray: true, default: `'{}'` },
          { name: 'regions', type: 'text', isArray: true, isNullable: true },
          { name: 'priority', type: 'integer', default: 0 },
          { name: 'active', type: 'boolean', default: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          {
            name: 'CHK_shipping_zones_priority_non_negative',
            expression: '"priority" >= 0',
          },
          /**
           * A region-scoped zone that covers no country, or every country, is
           * meaningless: `regions` only ever narrows a country. Without this,
           * a zone with `countries = '{}'` and `regions = '{CA}'` would silently
           * match California in *any* country that happens to have one.
           */
          {
            name: 'CHK_shipping_zones_regions_need_a_country',
            expression: '"regions" IS NULL OR cardinality("countries") > 0',
          },
          // An empty regions array is neither "the whole country" (null) nor a
          // list, and would match nothing. More likely a bug than an intention.
          {
            name: 'CHK_shipping_zones_regions_not_empty',
            expression: '"regions" IS NULL OR cardinality("regions") > 0',
          },
        ],
      }),
    );

    // Zone selection reads this on every quote: match, then highest priority.
    await queryRunner.createIndex(
      'shipping_zones',
      new TableIndex({
        name: 'IDX_shipping_zones_priority',
        columnNames: ['priority'],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'shipping_rates',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'zone_id', type: 'uuid' },
          { name: 'code', type: 'varchar' },
          { name: 'name', type: 'varchar' },
          { name: 'min_weight_g', type: 'integer', default: 0 },
          // NULL is the top band. Exclusive upper bound — see the entity.
          { name: 'max_weight_g', type: 'integer', isNullable: true },
          { name: 'price_minor', type: 'integer' },
          { name: 'free_over_minor', type: 'integer', isNullable: true },
          { name: 'currency', type: 'char', length: '3' },
          { name: 'active', type: 'boolean', default: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          {
            /**
             * **The invariant of this table.**
             *
             * A band whose top is at or below its bottom can never be selected,
             * so a rate written that way is invisible — the worst kind of
             * seeding bug, because nothing fails and a customer is simply
             * quoted the wrong band. This turns it into an error at the moment
             * the bad row is written.
             */
            name: 'CHK_shipping_rates_weight_band',
            expression: '"max_weight_g" IS NULL OR "max_weight_g" > "min_weight_g"',
          },
          {
            name: 'CHK_shipping_rates_min_weight_non_negative',
            expression: '"min_weight_g" >= 0',
          },
          // Zero is legitimate — a promotional free rate. Negative is not: it
          // would pay the customer to post them a parcel.
          {
            name: 'CHK_shipping_rates_price_non_negative',
            expression: '"price_minor" >= 0',
          },
          // A threshold of zero would make everything free, which is a rate of
          // 0 and should be written as one. Null means "never free".
          {
            name: 'CHK_shipping_rates_free_over_positive',
            expression: '"free_over_minor" IS NULL OR "free_over_minor" > 0',
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'shipping_rates',
      new TableForeignKey({
        name: 'FK_shipping_rates_zone',
        columnNames: ['zone_id'],
        referencedTableName: 'shipping_zones',
        referencedColumnNames: ['id'],
        // CASCADE, unlike coupons -> discounts: a rate has no meaning apart from
        // its zone, so deleting the zone should take its price list with it
        // rather than leaving orphan rows that can never be selected.
        onDelete: 'CASCADE',
      }),
    );

    /**
     * One band per service level per zone can start at a given weight.
     *
     * This does not prevent *overlapping* bands — 0–1000 and 500–2000 both
     * satisfy it — because that needs an exclusion constraint and the
     * `btree_gist` extension for one table. Selection is still deterministic
     * without it (the highest `min_weight_g` at or below the parcel's weight
     * wins), so an overlap picks a defined answer rather than a random one.
     * Recorded as a known limitation in ADR-0009 rather than hidden.
     */
    await queryRunner.createIndex(
      'shipping_rates',
      new TableIndex({
        name: 'UQ_shipping_rates_zone_code_band',
        columnNames: ['zone_id', 'code', 'min_weight_g'],
        isUnique: true,
      }),
    );

    // The rating query: every band for a zone, narrowed by service level.
    await queryRunner.createIndex(
      'shipping_rates',
      new TableIndex({
        name: 'IDX_shipping_rates_zone_code',
        columnNames: ['zone_id', 'code'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('shipping_rates', 'IDX_shipping_rates_zone_code');
    await queryRunner.dropIndex('shipping_rates', 'UQ_shipping_rates_zone_code_band');
    await queryRunner.dropForeignKey('shipping_rates', 'FK_shipping_rates_zone');
    await queryRunner.dropTable('shipping_rates');
    await queryRunner.dropIndex('shipping_zones', 'IDX_shipping_zones_priority');
    await queryRunner.dropTable('shipping_zones');
  }
}
