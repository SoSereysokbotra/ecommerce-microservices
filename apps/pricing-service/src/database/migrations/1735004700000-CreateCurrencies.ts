import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * M11 step 1: write down how many minor units a currency has.
 *
 * Nothing converts yet. This migration exists so that the assumption the whole
 * codebase has been making since M0 — that a minor unit is a hundredth — stops
 * being an assumption and becomes a row.
 *
 * See `CurrencyEntity` for why that matters, and
 * `docs/M11_CURRENCY_PLAN.md` §3 for the audit of all 17 money columns that
 * prompted it.
 */
export class CreateCurrencies1735004700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'currencies',
        columns: [
          { name: 'code', type: 'char', length: '3', isPrimary: true },
          { name: 'exponent', type: 'smallint' },
          { name: 'name', type: 'varchar' },
          { name: 'active', type: 'boolean', default: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
        checks: [
          /**
           * **The invariant of this table.**
           *
           * A wrong exponent misprices by a factor of a hundred, in the one
           * operation in this project that moves real money — Stripe is handed
           * an amount in the smallest currency unit, so an exponent that
           * disagrees with reality charges 100× or 1/100× what was agreed.
           *
           * No real currency has more than four decimal places, and none has a
           * negative one. Anything outside that is a typo, and this makes the
           * typo fail at the moment it is written rather than at the moment
           * somebody is charged. The same instinct as
           * `CHK_coupons_within_max_uses` in M9.
           */
          {
            name: 'CHK_currencies_exponent_range',
            expression: '"exponent" BETWEEN 0 AND 4',
          },
          // ISO 4217 is three upper-case letters. A lower-case or padded code
          // would fail to join against `products.currency` and show up as a
          // missing rate rather than as an error.
          {
            name: 'CHK_currencies_code_iso4217',
            expression: `"code" ~ '^[A-Z]{3}$'`,
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('currencies');
  }
}
