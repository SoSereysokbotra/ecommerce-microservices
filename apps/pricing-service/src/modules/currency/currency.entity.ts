import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A currency, and — the only reason this table exists — **how many minor units
 * make one unit of it.**
 *
 * Every amount in this project has been an integer number of minor units since
 * M0, and that discipline has held: no float has ever touched the pricing path.
 * But "minor units" has quietly meant *hundredths* everywhere, and nothing said
 * so. `formatMoney` divides by 100. The seed output divides by 100. Nobody wrote
 * `× 100` as a conversion; they wrote it as a fact.
 *
 * It is false for Japanese yen, which has no minor unit at all: ¥1000 is 1000,
 * not 100000. A codebase that divides by 100 shows ¥10.00 for a ¥1000 item and
 * charges a customer one hundredth of what they owe — while every existing test
 * still passes, because every existing test is in dollars.
 *
 * So the exponent is data, not an assumption:
 *
 *   USD, EUR   exponent 2    1000 minor units = 10.00
 *   JPY        exponent 0    1000 minor units = 1000
 *   KWD, BHD   exponent 3    1000 minor units = 1.000
 *
 * Nothing converts yet — that is step 2. This step only writes the fact down.
 */
@Entity({ name: 'currencies' })
export class CurrencyEntity {
  /** ISO 4217, upper case. The natural key: there is no id worth having. */
  @PrimaryColumn({ type: 'char', length: 3 })
  code: string;

  /**
   * How many decimal places the currency has — `10^exponent` minor units to one
   * major unit.
   *
   * A `smallint`, and constrained at the column, because a wrong value here
   * misprices by a factor of a hundred in the one place this project touches
   * real money. See the CHECK in the migration.
   */
  @Column({ type: 'smallint' })
  exponent: number;

  /** What a shopper sees in the switcher: 'US Dollar', 'Japanese Yen'. */
  @Column({ type: 'varchar' })
  name: string;

  /**
   * Deactivating is how a currency stops being offered without deleting it —
   * orders placed in it still need their code to resolve.
   */
  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
