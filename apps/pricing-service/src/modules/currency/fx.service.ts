import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RATE_SCALE, convert } from '../pricing/money';
import { CurrencyService } from './currency.service';
import { FxRateEntity } from './fx-rate.entity';

/** Parity, at the scale rates are stored in. */
export const PARITY_E8 = 10 ** RATE_SCALE;

/** A rate, and enough about it to freeze onto an order. */
export interface ResolvedRate {
  baseCurrency: string;
  quoteCurrency: string;
  rateE8: number;
  /** When the rate was observed. Frozen onto the order beside the rate itself. */
  fetchedAt: Date;
  /** How old it was when it was used. Null at parity, where there is no rate. */
  ageMs: number | null;
}

/**
 * The rate to use right now, and the exponents that go with it.
 *
 * ## It does not invert
 *
 * Asked for JPY→USD with only a USD→JPY row present, this **fails**. Inverting
 * would be one line and it would be wrong: real buy and sell rates are not
 * reciprocals, and a shop that silently sells at its buy rate loses the spread
 * on every transaction. If a reverse pair is wanted, it is a row.
 *
 * The M11 tests lean on the same fact — `money.spec.ts` asserts a round trip
 * through a buy and a sell rate does *not* return the original.
 *
 * ## A stale rate prices a basket slightly wrong; no rate prices nothing
 *
 * So age is reported, not enforced. A rate older than the configured age is a
 * warning in the log and a number on the response, for M19's metrics to pick
 * up — not an error that takes the shop down. Same reasoning M10 applied to a
 * shipment that fails to be created: it belongs in operations, not in a
 * customer-facing failure.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly staleAfterMs = Number(process.env.FX_STALE_AFTER_MS ?? 26 * 60 * 60 * 1000);

  constructor(
    @InjectRepository(FxRateEntity)
    private readonly rates: Repository<FxRateEntity>,
    private readonly currencies: CurrencyService,
  ) {}

  /**
   * The newest rate for a pair.
   *
   * Same currency both sides returns parity without reading the table — there
   * is no row to read, because the migration forbids one.
   */
  async resolve(baseCurrency: string, quoteCurrency: string): Promise<ResolvedRate> {
    const base = baseCurrency.toUpperCase();
    const quote = quoteCurrency.toUpperCase();

    if (base === quote) {
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        rateE8: PARITY_E8,
        fetchedAt: new Date(),
        ageMs: null,
      };
    }

    const row = await this.rates.findOne({
      where: { baseCurrency: base, quoteCurrency: quote },
      order: { fetchedAt: 'DESC' },
    });

    if (!row) {
      // Deliberately not falling back to an inverted rate or to parity. Both
      // would produce a number, and a wrong number here is charged to somebody.
      throw new NotFoundException(`No exchange rate from ${base} to ${quote}`);
    }

    const ageMs = Date.now() - row.fetchedAt.getTime();

    if (ageMs > this.staleAfterMs) {
      this.logger.warn(
        `Using a stale ${base}->${quote} rate: ${Math.round(ageMs / 3_600_000)}h old ` +
          `(source ${row.source}). Quotes still work; the refresh is behind.`,
      );
    }

    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rateE8: row.rateE8,
      fetchedAt: row.fetchedAt,
      ageMs,
    };
  }

  /**
   * Convert one amount, resolving both exponents.
   *
   * The exponents come from the `currencies` table rather than from the caller,
   * which is the whole reason that table exists: a caller that could pass an
   * exponent could pass the wrong one, and being wrong costs a factor of a
   * hundred.
   */
  async convertAmount(
    amountMinor: number,
    from: string,
    to: string,
    rate?: ResolvedRate,
  ): Promise<number> {
    if (from.toUpperCase() === to.toUpperCase()) {
      return amountMinor;
    }

    const [fromCurrency, toCurrency, resolved] = await Promise.all([
      this.currencies.require(from),
      this.currencies.require(to),
      rate ? Promise.resolve(rate) : this.resolve(from, to),
    ]);

    return convert(amountMinor, {
      rateE8: resolved.rateE8,
      fromExponent: fromCurrency.exponent,
      toExponent: toCurrency.exponent,
    });
  }

  /** Every rate currently in force, newest per pair. For debugging a total. */
  async current(): Promise<FxRateEntity[]> {
    const rows = await this.rates.find({ order: { fetchedAt: 'DESC' } });
    const newest = new Map<string, FxRateEntity>();

    for (const row of rows) {
      const key = `${row.baseCurrency}->${row.quoteCurrency}`;
      if (!newest.has(key)) newest.set(key, row);
    }

    return [...newest.values()].sort((a, b) =>
      `${a.baseCurrency}${a.quoteCurrency}`.localeCompare(`${b.baseCurrency}${b.quoteCurrency}`),
    );
  }
}
