/**
 * What a parcel costs to send: zone selection, band selection, free-shipping.
 *
 * Pure functions over plain data, with no repository and no database — the same
 * shape as `quote.ts` in pricing-service, and for the same reason. The rules
 * here are the part that can be wrong in a way nobody notices (a boundary off by
 * one gram, a threshold compared with the wrong operator), so they have to be
 * testable exhaustively and cheaply. `npm run test:all` stays database-free.
 *
 * `ShippingService` does the reading; this file does the deciding.
 */

export interface Destination {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** State or province code, or null for a country-level destination. */
  region: string | null;
}

/** A zone as the rating rules see it — the entity minus its timestamps. */
export interface ZoneRule {
  code: string;
  name: string;
  /** Empty means every country. See ShippingZoneEntity.countries. */
  countries: readonly string[];
  /** Null means the whole country. */
  regions: readonly string[] | null;
  priority: number;
  active: boolean;
}

/** A rate band as the rating rules see it. */
export interface RateRule {
  code: string;
  name: string;
  minWeightG: number;
  /** Exclusive upper bound. Null is the top band. */
  maxWeightG: number | null;
  priceMinor: number;
  freeOverMinor: number | null;
  currency: string;
  active: boolean;
}

export interface RateOption {
  code: string;
  name: string;
  /** What this service level costs for this basket. Zero when free applied. */
  costMinor: number;
  /** True when a `free_over_minor` threshold zeroed an otherwise real price. */
  freeApplied: boolean;
  /** The undiscounted band price, so the storefront can show "was $5.99". */
  listPriceMinor: number;
  currency: string;
}

export interface RatingInput {
  destination: Destination;
  /** Total basket weight. Zero is legitimate — every product defaults to 0g. */
  weightGrams: number;
  /**
   * The **discounted** subtotal, which is what free-shipping thresholds are
   * compared against. See `ShippingRateEntity.freeOverMinor` for why.
   */
  subtotalMinor: number;
}

export interface RatingResult {
  /** Null when no zone covers this destination at all — see `selectZone`. */
  zone: string | null;
  weightGrams: number;
  /** Cheapest first, then by code. Empty when nothing ships there. */
  options: RateOption[];
  /** What applies when the caller names no service level. Null if none do. */
  cheapestCode: string | null;
}

/**
 * The zone that covers a destination, or null.
 *
 * Highest `priority` wins, ties broken by `code` so the answer never depends on
 * row order. Three rules, and each one earns its line:
 *
 * - An **empty** `countries` matches every country. That is how `ROW` is
 *   written, and it is why a destination nobody anticipated still gets a price.
 * - A zone with `regions` set matches only those regions. `region = ANY(regions)`
 *   is already false for a destination with no region, so a country-level
 *   address correctly falls through to the country-level zone rather than
 *   matching a state-level one.
 * - Inactive zones are invisible. Deactivating a zone is how you stop shipping
 *   somewhere without deleting its price history.
 */
export function selectZone(zones: readonly ZoneRule[], destination: Destination): ZoneRule | null {
  const country = destination.country.toUpperCase();
  const region = destination.region?.toUpperCase() ?? null;

  const matches = zones.filter((zone) => {
    if (!zone.active) return false;

    const coversCountry =
      zone.countries.length === 0 || zone.countries.some((c) => c.toUpperCase() === country);
    if (!coversCountry) return false;

    if (zone.regions === null) return true;
    return region !== null && zone.regions.some((r) => r.toUpperCase() === region);
  });

  if (matches.length === 0) return null;

  return matches.reduce((best, zone) => {
    if (zone.priority !== best.priority) return zone.priority > best.priority ? zone : best;
    return zone.code < best.code ? zone : best;
  });
}

/**
 * The band a weight falls into, for one service level.
 *
 * Bands are **half-open**: `min_weight_g <= w < max_weight_g`. A parcel weighing
 * exactly `max_weight_g` belongs to the next band up, which is the boundary the
 * unit tests pin down and the one most likely to be got wrong.
 *
 * `bandsCovering` is exported separately so a test can assert that exactly
 * **one** band matches a weight. Asserting only on `selectBand`'s answer is not
 * enough: with a closed upper bound both bands match at the boundary and the
 * overlap tie-break below still returns the right one, so the bug hides. That
 * is not hypothetical — it is what a mutation of `>` to `>=` did to the first
 * version of these tests, which passed.
 *
 * When bands overlap — which the schema permits, because excluding it needs
 * `btree_gist` for one table — the **highest** matching `min_weight_g` wins. So
 * an overlap produces a defined answer rather than whichever row came back
 * first. See the note on `UQ_shipping_rates_zone_code_band` in the migration.
 */
export function bandsCovering(rates: readonly RateRule[], weightGrams: number): RateRule[] {
  return rates.filter(
    (rate) =>
      rate.active &&
      rate.minWeightG <= weightGrams &&
      (rate.maxWeightG === null || rate.maxWeightG > weightGrams),
  );
}

export function selectBand(rates: readonly RateRule[], weightGrams: number): RateRule | null {
  const matching = bandsCovering(rates, weightGrams);

  if (matching.length === 0) return null;

  return matching.reduce((best, rate) => (rate.minWeightG > best.minWeightG ? rate : best));
}

/**
 * Price every service level available in a zone.
 *
 * A free-shipping threshold produces a `costMinor` of **0**, not a discount.
 * Keeping it out of `discountMinor` leaves that field meaning exactly one thing
 * — promotions and coupons against the goods — and means a shopper who
 * qualified can be told "Free" rather than shown a shipping charge and a
 * matching credit two lines apart.
 */
export function rateOptions(rates: readonly RateRule[], input: RatingInput): RateOption[] {
  const serviceLevels = [...new Set(rates.filter((r) => r.active).map((r) => r.code))];

  const options: RateOption[] = [];

  for (const code of serviceLevels) {
    const band = selectBand(
      rates.filter((r) => r.code === code),
      input.weightGrams,
    );

    // A service level with no band covering this weight simply is not offered.
    // Heavier than express handles is a real thing; it is not an error.
    if (!band) continue;

    const freeApplied =
      band.freeOverMinor !== null &&
      input.subtotalMinor >= band.freeOverMinor &&
      band.priceMinor > 0;

    options.push({
      code: band.code,
      name: band.name,
      costMinor: freeApplied ? 0 : band.priceMinor,
      freeApplied,
      listPriceMinor: band.priceMinor,
      currency: band.currency,
    });
  }

  // Cheapest first, ties by code. The order is part of the contract: it is what
  // makes "the caller named no service level" resolve to something specific.
  return options.sort((a, b) => a.costMinor - b.costMinor || a.code.localeCompare(b.code));
}

/**
 * The whole answer for one basket.
 *
 * A destination no zone covers returns `zone: null` and no options rather than
 * an error. "We do not ship there" is a fact about the shop, not a fault in the
 * request, and a 404 here would tell a customer their address was invalid.
 */
export function rate(
  zones: readonly ZoneRule[],
  ratesByZone: (zone: ZoneRule) => readonly RateRule[],
  input: RatingInput,
): RatingResult {
  const zone = selectZone(zones, input.destination);

  if (!zone) {
    return { zone: null, weightGrams: input.weightGrams, options: [], cheapestCode: null };
  }

  const options = rateOptions(ratesByZone(zone), input);

  return {
    zone: zone.code,
    weightGrams: input.weightGrams,
    options,
    cheapestCode: options.length > 0 ? options[0].code : null,
  };
}
