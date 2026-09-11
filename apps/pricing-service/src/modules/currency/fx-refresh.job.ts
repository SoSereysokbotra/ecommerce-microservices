import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RATE_SCALE } from '../pricing/money';
import { CurrencyEntity } from './currency.entity';
import { FxRateEntity } from './fx-rate.entity';

/** What a provider is expected to return: quote currency to rate, against one base. */
interface ProviderResponse {
  base?: string;
  rates?: Record<string, number>;
}

export interface RefreshOutcome {
  attempted: boolean;
  inserted: number;
  skipped: number;
  error: string | null;
}

/**
 * Keeps the rate table current.
 *
 * ## Why this exists with no provider configured
 *
 * `FX_PROVIDER_URL` is unset by default and this project has no FX API key.
 * That is deliberate: the milestone's content is the **pattern** — an
 * append-only log, refreshed on a schedule, with the rate used frozen at
 * purchase — not an HTTP call to a vendor. Point it at a real provider and it
 * works; leave it unset and the seeded rates stand.
 *
 * The job still earns its place unconfigured, because the two questions that
 * actually matter are about failure and history, not about fetching:
 *
 * ## A refresh must never rewrite history
 *
 * Rates are **inserted, never updated**. The newest row for a pair wins, so
 * "what was the rate on Tuesday" stays answerable and a refresh cannot alter a
 * figure some quote already used. An order is protected either way — it freezes
 * the rate onto itself — but a table that updated in place would make the order
 * the *only* record, and a bug in that freezing would then be invisible.
 *
 * ## A failed refresh must not take the shop down
 *
 * A stale rate prices a basket slightly wrong. **No rate prices nothing.** So a
 * provider that is unreachable, slow, or returning nonsense leaves the last
 * known rate exactly where it is and logs; `FxService` separately warns when
 * the rate it used was older than expected. That is an operational signal for
 * M19's metrics, not a customer-facing error — the same call M10 made about a
 * shipment that fails to be created.
 */
@Injectable()
export class FxRefreshJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FxRefreshJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly intervalMs = Number(process.env.FX_REFRESH_MS ?? 60 * 60 * 1000);
  private readonly providerUrl = process.env.FX_PROVIDER_URL ?? '';
  private readonly timeoutMs = Number(process.env.FX_PROVIDER_TIMEOUT_MS ?? 5000);
  private readonly baseCurrency = (process.env.FX_BASE_CURRENCY ?? 'USD').toUpperCase();

  constructor(
    @InjectRepository(FxRateEntity)
    private readonly rates: Repository<FxRateEntity>,
    @InjectRepository(CurrencyEntity)
    private readonly currencies: Repository<CurrencyEntity>,
  ) {}

  onModuleInit(): void {
    if (!this.providerUrl) {
      this.logger.log('No FX_PROVIDER_URL configured; seeded rates stand. Refresh disabled.');
      return;
    }

    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // `unref` so a pending timer cannot hold the process open on shutdown —
    // the same thing cart's and inventory's sweeps do.
    this.timer.unref?.();
    this.logger.log(`FX refresh every ${this.intervalMs}ms from ${this.providerUrl}`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed so a test can force a refresh rather than wait for the timer. */
  async refresh(): Promise<RefreshOutcome> {
    if (!this.providerUrl) {
      return { attempted: false, inserted: 0, skipped: 0, error: null };
    }

    // A slow provider must not stack up refreshes on top of each other.
    if (this.running) {
      this.logger.debug('Refresh already in flight; skipping this tick');
      return { attempted: false, inserted: 0, skipped: 0, error: null };
    }
    this.running = true;

    try {
      const quoted = await this.fetchRates();
      return await this.store(quoted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      // Logged, not thrown. Nothing is waiting on this, and the last known
      // rate is still there — which is the whole point.
      this.logger.warn(
        `FX refresh failed: ${reason}. Keeping the last known rates; quotes are unaffected.`,
      );
      return { attempted: true, inserted: 0, skipped: 0, error: reason };
    } finally {
      this.running = false;
    }
  }

  private async fetchRates(): Promise<Record<string, number>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.providerUrl}${this.providerUrl.includes('?') ? '&' : '?'}base=${this.baseCurrency}`;
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        throw new Error(`provider returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as ProviderResponse;

      // A provider quoting against a different base would silently invert every
      // rate in the table. Refuse rather than convert — see FxService on why
      // this project does not invert rates.
      if (body.base && body.base.toUpperCase() !== this.baseCurrency) {
        throw new Error(`provider quoted against ${body.base}, expected ${this.baseCurrency}`);
      }

      if (!body.rates || typeof body.rates !== 'object') {
        throw new Error('provider response had no rates object');
      }

      return body.rates;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Insert one row per currency we actually offer.
   *
   * Everything the provider sends for a currency this shop does not sell is
   * skipped rather than stored: an `fx_rates` row for a currency with no
   * `currencies` entry would fail the foreign key anyway, and filtering here
   * makes the reason legible in the count rather than in an exception.
   */
  private async store(quoted: Record<string, number>): Promise<RefreshOutcome> {
    const known = await this.currencies.find();
    const offered = new Set(known.map((c) => c.code));

    const rows: Partial<FxRateEntity>[] = [];
    let skipped = 0;

    for (const [code, rate] of Object.entries(quoted)) {
      const quoteCurrency = code.toUpperCase();

      // Parity is not a row — the migration forbids base === quote, because a
      // second path to parity could disagree with the one in `convert()`.
      if (quoteCurrency === this.baseCurrency || !offered.has(quoteCurrency)) {
        skipped++;
        continue;
      }

      // A provider glitch returning 0, a negative, or a non-number would be
      // caught by the CHECK constraint, but as a failed transaction that loses
      // the good rows alongside the bad one. Filter first.
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        this.logger.warn(
          `Ignoring implausible ${this.baseCurrency}->${quoteCurrency} rate: ${rate}`,
        );
        skipped++;
        continue;
      }

      rows.push({
        baseCurrency: this.baseCurrency,
        quoteCurrency,
        rateE8: Math.round(rate * 10 ** RATE_SCALE),
        source: new URL(this.providerUrl).host,
      });
    }

    if (rows.length > 0) {
      await this.rates.insert(rows as FxRateEntity[]);
    }

    this.logger.log(`FX refresh: ${rows.length} rate(s) recorded, ${skipped} skipped`);
    return { attempted: true, inserted: rows.length, skipped, error: null };
  }
}
