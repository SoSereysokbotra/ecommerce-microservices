import {
  RateRule,
  ZoneRule,
  bandsCovering,
  rate,
  rateOptions,
  selectBand,
  selectZone,
} from '../src/modules/shipping/rating';

/**
 * The rating rules, tested against the same four zones the seed writes.
 *
 * Three things here are worth more than the rest, and they are the three
 * docs/M10_SHIPPING_PLAN.md §10 named before any of this was built:
 *
 *   1. Zone priority — `US-CA` must beat `US` for a Californian address, and
 *      `US-PA` must fall back to `US`. Both directions of the same rule.
 *   2. The band boundary — a parcel weighing **exactly** `max_weight_g` belongs
 *      to the next band up. This is the off-by-one that costs a shop money in
 *      one direction and a customer's trust in the other, and it is invisible
 *      unless someone tests the exact gram.
 *   3. The free-shipping threshold — one minor unit below pays, exactly at it
 *      does not. `>` and `>=` are one keystroke apart.
 */

const zone = (over: Partial<ZoneRule> & { code: string }): ZoneRule => ({
  name: over.code,
  countries: [],
  regions: null,
  priority: 0,
  active: true,
  ...over,
});

const band = (over: Partial<RateRule> & { code: string }): RateRule => ({
  name: over.code,
  minWeightG: 0,
  maxWeightG: null,
  priceMinor: 500,
  freeOverMinor: null,
  currency: 'USD',
  active: true,
  ...over,
});

/** The four zones the seed writes, in the shape the rules see them. */
const SEEDED_ZONES: ZoneRule[] = [
  zone({ code: 'US-CA', countries: ['US'], regions: ['CA'], priority: 30 }),
  zone({ code: 'US', countries: ['US'], regions: null, priority: 20 }),
  zone({ code: 'EU', countries: ['DE', 'FR', 'NL'], regions: null, priority: 20 }),
  zone({ code: 'ROW', countries: [], regions: null, priority: 0 }),
];

describe('selectZone', () => {
  it('prefers the more specific zone: US-CA beats US for California', () => {
    expect(selectZone(SEEDED_ZONES, { country: 'US', region: 'CA' })?.code).toBe('US-CA');
  });

  it('falls back to the country zone for a state nothing covers', () => {
    expect(selectZone(SEEDED_ZONES, { country: 'US', region: 'PA' })?.code).toBe('US');
  });

  it('does not match a region-scoped zone when the destination has no region', () => {
    // The other half of the same rule. A US address with no state must not be
    // quoted Californian prices just because California is the narrowest match.
    expect(selectZone(SEEDED_ZONES, { country: 'US', region: null })?.code).toBe('US');
  });

  it('matches any country listed in a multi-country zone', () => {
    expect(selectZone(SEEDED_ZONES, { country: 'DE', region: null })?.code).toBe('EU');
    expect(selectZone(SEEDED_ZONES, { country: 'FR', region: null })?.code).toBe('EU');
  });

  it('falls through to the catch-all for a country nothing lists', () => {
    // The reason ROW exists: a shop that 404s an unusual country is worse than
    // one that quotes a high price.
    expect(selectZone(SEEDED_ZONES, { country: 'KH', region: null })?.code).toBe('ROW');
    expect(selectZone(SEEDED_ZONES, { country: 'KH', region: 'XX' })?.code).toBe('ROW');
  });

  it('is case-insensitive about country and region codes', () => {
    expect(selectZone(SEEDED_ZONES, { country: 'us', region: 'ca' })?.code).toBe('US-CA');
  });

  it('ignores inactive zones, falling through to the next match', () => {
    const zones = [
      zone({ code: 'US-CA', countries: ['US'], regions: ['CA'], priority: 30, active: false }),
      ...SEEDED_ZONES.slice(1),
    ];
    expect(selectZone(zones, { country: 'US', region: 'CA' })?.code).toBe('US');
  });

  it('breaks ties on priority by code, so the answer never depends on row order', () => {
    const tied = [
      zone({ code: 'BBB', countries: ['US'], priority: 10 }),
      zone({ code: 'AAA', countries: ['US'], priority: 10 }),
    ];
    expect(selectZone(tied, { country: 'US', region: null })?.code).toBe('AAA');
    expect(selectZone([...tied].reverse(), { country: 'US', region: null })?.code).toBe('AAA');
  });

  it('returns null when nothing covers the destination and there is no catch-all', () => {
    const noCatchAll = SEEDED_ZONES.filter((z) => z.code !== 'ROW');
    expect(selectZone(noCatchAll, { country: 'KH', region: null })).toBeNull();
  });
});

describe('selectBand — half-open [min, max)', () => {
  const bands = [
    band({ code: 'standard', minWeightG: 0, maxWeightG: 1000, priceMinor: 599 }),
    band({ code: 'standard', minWeightG: 1000, maxWeightG: null, priceMinor: 999 }),
  ];

  it('puts a weight one gram below the boundary in the lower band', () => {
    expect(selectBand(bands, 999)?.priceMinor).toBe(599);
  });

  it('puts a weight EXACTLY at max_weight_g in the NEXT band up', () => {
    // The whole reason the bounds are half-open. With `<=` here, 1000g would
    // match both bands and the answer would depend on which row came back
    // first.
    expect(selectBand(bands, 1000)?.priceMinor).toBe(999);
  });

  it('puts a weight one gram above the boundary in the upper band', () => {
    expect(selectBand(bands, 1001)?.priceMinor).toBe(999);
  });

  it('rates a zero-weight basket into the lightest band', () => {
    // Every catalog product defaults to weight_grams = 0, so this is the case a
    // basket of unweighed products hits — it must ship, not fail.
    expect(selectBand(bands, 0)?.priceMinor).toBe(599);
  });

  it('matches exactly one band at the boundary — no gap and no overlap', () => {
    // Deliberately asserts on `bandsCovering`, the real filter, rather than on
    // `selectBand`'s answer. An earlier version of this test re-implemented the
    // predicate inline and so tested a literal written in this file; a second
    // version called `selectBand`, which still returns the right band at 1000g
    // even with a closed upper bound, because the overlap tie-break covers for
    // it. Both passed against code mutated from `>` to `>=`. This does not.
    expect(bandsCovering(bands, 999)).toHaveLength(1);
    expect(bandsCovering(bands, 1000)).toHaveLength(1);
    expect(bandsCovering(bands, 1001)).toHaveLength(1);
  });

  it('has no gap: every weight from 0 to 3000 is covered by exactly one band', () => {
    for (let w = 0; w <= 3000; w++) {
      expect(bandsCovering(bands, w)).toHaveLength(1);
    }
  });

  it('returns null when no band covers the weight, rather than guessing', () => {
    const capped = [band({ code: 'express', minWeightG: 0, maxWeightG: 2000 })];
    expect(selectBand(capped, 2000)).toBeNull();
  });

  it('resolves an overlap deterministically: highest min_weight_g wins', () => {
    // The schema permits overlapping bands — excluding them needs btree_gist for
    // one table. Selection must still give a defined answer, not whichever row
    // Postgres returned first.
    const overlapping = [
      band({ code: 'standard', minWeightG: 0, maxWeightG: 2000, priceMinor: 100 }),
      band({ code: 'standard', minWeightG: 500, maxWeightG: 2000, priceMinor: 200 }),
    ];
    expect(selectBand(overlapping, 1000)?.priceMinor).toBe(200);
    expect(selectBand([...overlapping].reverse(), 1000)?.priceMinor).toBe(200);
  });

  it('ignores inactive bands', () => {
    const withInactive = [
      band({ code: 'standard', minWeightG: 0, maxWeightG: 1000, priceMinor: 599 }),
      band({ code: 'standard', minWeightG: 500, maxWeightG: null, priceMinor: 999, active: false }),
    ];
    expect(selectBand(withInactive, 600)?.priceMinor).toBe(599);
  });
});

describe('rateOptions — free shipping thresholds', () => {
  const usStandard = [
    band({
      code: 'standard',
      minWeightG: 0,
      maxWeightG: null,
      priceMinor: 599,
      freeOverMinor: 7500,
    }),
  ];

  const at = (subtotalMinor: number) =>
    rateOptions(usStandard, {
      destination: { country: 'US', region: null },
      weightGrams: 0,
      subtotalMinor,
    })[0];

  it('charges one minor unit below the threshold', () => {
    expect(at(7499)).toMatchObject({ costMinor: 599, freeApplied: false });
  });

  it('is free EXACTLY at the threshold', () => {
    // "Free over $75" means $75 qualifies. `>` instead of `>=` here charges the
    // one customer who spent exactly the advertised amount.
    expect(at(7500)).toMatchObject({ costMinor: 0, freeApplied: true });
  });

  it('is free above the threshold', () => {
    expect(at(9999)).toMatchObject({ costMinor: 0, freeApplied: true });
  });

  it('keeps the list price when free applies, so the saving can be shown', () => {
    expect(at(7500).listPriceMinor).toBe(599);
  });

  it('never applies free when the rate has no threshold', () => {
    const noThreshold = [band({ code: 'standard', priceMinor: 1999, freeOverMinor: null })];
    const [option] = rateOptions(noThreshold, {
      destination: { country: 'KH', region: null },
      weightGrams: 0,
      subtotalMinor: 1_000_000,
    });
    expect(option).toMatchObject({ costMinor: 1999, freeApplied: false });
  });

  it('does not report freeApplied for a rate that was already zero', () => {
    // A permanently free rate and a basket that earned free shipping are
    // different facts. Only the second one is worth telling the shopper about.
    const alreadyFree = [band({ code: 'standard', priceMinor: 0, freeOverMinor: 1000 })];
    const [option] = rateOptions(alreadyFree, {
      destination: { country: 'US', region: null },
      weightGrams: 0,
      subtotalMinor: 5000,
    });
    expect(option).toMatchObject({ costMinor: 0, freeApplied: false });
  });
});

describe('rateOptions — service levels', () => {
  const rates = [
    band({ code: 'standard', minWeightG: 0, maxWeightG: 1000, priceMinor: 599 }),
    band({ code: 'standard', minWeightG: 1000, maxWeightG: null, priceMinor: 999 }),
    band({ code: 'express', minWeightG: 0, maxWeightG: 2000, priceMinor: 1999 }),
  ];

  const optionsAt = (weightGrams: number, subtotalMinor = 1000) =>
    rateOptions(rates, {
      destination: { country: 'US', region: null },
      weightGrams,
      subtotalMinor,
    });

  it('offers every service level whose band covers the weight', () => {
    expect(optionsAt(500).map((o) => o.code)).toEqual(['standard', 'express']);
  });

  it('drops a service level that cannot carry the weight, rather than erroring', () => {
    // Heavier than express handles is a real thing, not a broken request.
    expect(optionsAt(2500).map((o) => o.code)).toEqual(['standard']);
  });

  it('sorts cheapest first', () => {
    expect(optionsAt(1500).map((o) => o.costMinor)).toEqual([999, 1999]);
  });

  it('picks each service level its own band independently', () => {
    const options = optionsAt(1500);
    expect(options.find((o) => o.code === 'standard')?.costMinor).toBe(999);
    expect(options.find((o) => o.code === 'express')?.costMinor).toBe(1999);
  });
});

describe('rate — the whole answer', () => {
  const ratesFor = (z: ZoneRule): RateRule[] =>
    z.code === 'ROW'
      ? [band({ code: 'standard', priceMinor: 1999 })]
      : [
          band({
            code: 'standard',
            minWeightG: 0,
            maxWeightG: 1000,
            priceMinor: 599,
            freeOverMinor: 7500,
          }),
          band({
            code: 'standard',
            minWeightG: 1000,
            maxWeightG: null,
            priceMinor: 999,
            freeOverMinor: 7500,
          }),
          band({ code: 'express', priceMinor: 1999 }),
        ];

  it('names the zone it used and the cheapest option', () => {
    const result = rate(SEEDED_ZONES, ratesFor, {
      destination: { country: 'US', region: 'CA' },
      weightGrams: 1200,
      subtotalMinor: 3000,
    });
    expect(result).toMatchObject({ zone: 'US-CA', weightGrams: 1200, cheapestCode: 'standard' });
    expect(result.options).toHaveLength(2);
  });

  it('returns no zone and no options — not an error — when nothing ships there', () => {
    // "We do not ship there" is a fact about the shop. A 404 would tell the
    // customer their address was invalid, which is a different and wrong claim.
    const result = rate(
      SEEDED_ZONES.filter((z) => z.code !== 'ROW'),
      ratesFor,
      {
        destination: { country: 'KH', region: null },
        weightGrams: 100,
        subtotalMinor: 1000,
      },
    );
    expect(result).toEqual({ zone: null, weightGrams: 100, options: [], cheapestCode: null });
  });

  it('reports the free option as cheapest once the threshold is met', () => {
    const result = rate(SEEDED_ZONES, ratesFor, {
      destination: { country: 'US', region: 'CA' },
      weightGrams: 500,
      subtotalMinor: 7500,
    });
    expect(result.cheapestCode).toBe('standard');
    expect(result.options[0]).toMatchObject({ costMinor: 0, freeApplied: true });
  });
});
