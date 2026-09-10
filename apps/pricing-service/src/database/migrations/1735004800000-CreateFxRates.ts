import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * M11 step 3: exchange rates, as an append-only log.
 *
 * See `FxRateEntity` for why there is no unique constraint on the pair.
 */
export class CreateFxRates1735004800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'fx_rates',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          { name: 'base_currency', type: 'char', length: '3' },
          { name: 'quote_currency', type: 'char', length: '3' },
          // The rate × 10^8. bigint because 10^8 scale on a four-figure rate is
          // already past what an `integer` holds.
          { name: 'rate_e8', type: 'bigint' },
          { name: 'fetched_at', type: 'timestamptz', default: 'now()' },
          { name: 'source', type: 'varchar', default: `'seed'` },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          // A zero or negative rate would make everything free or negative, and
          // would do it silently — `convert` multiplies, it does not sanity
          // check the business meaning.
          { name: 'CHK_fx_rates_positive', expression: '"rate_e8" > 0' },
          /**
           * A currency cannot have a rate against itself.
           *
           * `convert()` short-circuits parity to return the input untouched. A
           * USD→USD row would be a **second** path to parity that could
           * disagree with the first — 0.9999 through a rounding, say — and the
           * two would be chosen by whichever code path ran. One way to be at
           * parity, enforced here.
           */
          {
            name: 'CHK_fx_rates_distinct_currencies',
            expression: '"base_currency" <> "quote_currency"',
          },
        ],
      }),
    );

    for (const column of ['base_currency', 'quote_currency']) {
      await queryRunner.createForeignKey(
        'fx_rates',
        new TableForeignKey({
          name: `FK_fx_rates_${column}`,
          columnNames: [column],
          referencedTableName: 'currencies',
          referencedColumnNames: ['code'],
          // RESTRICT: a currency with rate history cannot be deleted out from
          // under it. Deactivate it instead — that is what `active` is for.
          onDelete: 'RESTRICT',
        }),
      );
    }

    /**
     * The only query this table serves: "the newest rate for this pair".
     *
     * `fetched_at DESC` in the index rather than sorting at read time, because
     * this runs on every quote in a non-base currency and the table only grows.
     */
    await queryRunner.query(
      `CREATE INDEX "IDX_fx_rates_pair_newest"
         ON "fx_rates" ("base_currency", "quote_currency", "fetched_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('fx_rates', 'IDX_fx_rates_pair_newest');
    await queryRunner.dropForeignKey('fx_rates', 'FK_fx_rates_quote_currency');
    await queryRunner.dropForeignKey('fx_rates', 'FK_fx_rates_base_currency');
    await queryRunner.dropTable('fx_rates');
  }
}
