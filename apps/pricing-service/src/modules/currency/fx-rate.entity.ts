import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One observation of an exchange rate, at a moment in time.
 *
 * ## Append-only, deliberately
 *
 * There is **no unique constraint on the pair**. A refresh inserts a new row;
 * the newest one wins. That is not an oversight, it is the design:
 *
 * - "What was the rate on Tuesday?" is answerable, which matters the first time
 *   a customer queries a total.
 * - A refresh cannot rewrite a figure a quote has already used. An order is
 *   protected anyway — it freezes the rate onto itself, the way M8 froze tax
 *   and M10 froze shipping — but a table that updates in place would make the
 *   order the *only* record, and then a bug in the freezing would be invisible.
 *
 * The cost is a table that grows. At one refresh an hour for three pairs that
 * is ~26k rows a year, which is nothing, and the index below is what keeps
 * "newest per pair" cheap regardless.
 */
@Entity({ name: 'fx_rates' })
export class FxRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** What the price is quoted *in* — the catalog's currency, USD here. */
  @Column({ name: 'base_currency', type: 'char', length: 3 })
  baseCurrency: string;

  /** What it is being converted *to*. */
  @Column({ name: 'quote_currency', type: 'char', length: 3 })
  quoteCurrency: string;

  /**
   * The rate × 10^8, as an integer.
   *
   * Integer discipline, like every other number in this service — a rate stored
   * as a float is a float in the pricing path, which this project has never
   * allowed. USD→JPY at 150.25 is `15_025_000_000`.
   *
   * Stored as `bigint` and read back through a transformer: TypeORM hands
   * `bigint` columns to JavaScript as **strings**, and `'15025000000' * 2` is
   * the kind of bug that produces a plausible wrong number rather than an
   * error.
   */
  @Column({
    name: 'rate_e8',
    type: 'bigint',
    transformer: {
      to: (value: number) => value,
      from: (value: string | number | null) => (value === null ? null : Number(value)),
    },
  })
  rateE8: number;

  /**
   * When this rate was observed — not when the row was written.
   *
   * A provider's response carries its own timestamp, and using it means a
   * replayed or delayed refresh cannot make a stale rate look fresh.
   */
  @Column({ name: 'fetched_at', type: 'timestamptz', default: () => 'now()' })
  fetchedAt: Date;

  /** Where it came from: `'seed'`, or the provider that supplied it. */
  @Column({ type: 'varchar', default: 'seed' })
  source: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
