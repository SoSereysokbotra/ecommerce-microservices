import 'reflect-metadata';
import { AppDataSource } from './typeorm.config';
import { ShippingZoneEntity } from '../modules/shipping/shipping-zone.entity';
import { ShippingRateEntity } from '../modules/shipping/shipping-rate.entity';

/**
 * Idempotent seed — safe to re-run. Matches on the natural key and updates
 * rather than inserting duplicates, the same way the catalog and pricing seeds
 * do.
 *
 * ## Why these four zones
 *
 * They line up with the three tax destinations M8 seeded (`US-CA`, `US-PA`,
 * `DE`), because the acceptance test for this milestone is the M8 one extended:
 * one basket, three regions, three totals — now each including shipping. Every
 * zone here is reachable from the storefront's existing region selector.
 *
 *   US-CA  priority 30, overlaps US on purpose. The warehouse is in California,
 *          so in-state delivery is cheaper and free sooner. This is the row that
 *          proves priority works: a Californian address matches both this and
 *          `US`, and must get this one.
 *   US     priority 20. What US-PA falls back to, exercising the *other* side of
 *          the same rule with no extra machinery.
 *   EU     priority 20. Reached by DE. Cannot tie with US — no country is in
 *          both — so equal priorities are safe here and the tie-break by code
 *          is belt-and-braces.
 *   ROW    priority 0, `countries: []`, matches anything nothing else did. Every
 *          destination must rate; a shop that 404s an unusual country is worse
 *          than one that quotes a high price.
 *
 * ## Why every price is USD
 *
 * Same reason M8's seed prices three tax regions in USD: tax region, shipping
 * zone and currency are independent, and multi-currency is M11. A EUR rate here
 * would mean solving FX in the milestone about weight bands.
 */
const ZONES = [
  {
    code: 'US-CA',
    name: 'California (local)',
    countries: ['US'],
    regions: ['CA'],
    priority: 30,
    rates: [
      // Free over $50 in-state — the lower threshold is the whole point of
      // having a local zone, and it is what the free-shipping test exercises.
      {
        code: 'standard',
        name: 'Standard (2–3 days)',
        minWeightG: 0,
        maxWeightG: 1000,
        priceMinor: 399,
        freeOverMinor: 5000,
      },
      {
        code: 'standard',
        name: 'Standard (2–3 days)',
        minWeightG: 1000,
        maxWeightG: null,
        priceMinor: 699,
        freeOverMinor: 5000,
      },
      // One unbanded express rate per zone: a service level is not obliged to
      // have the same band structure as its neighbours, and a single row proves
      // the selector does not assume it does.
      {
        code: 'express',
        name: 'Express (next day)',
        minWeightG: 0,
        maxWeightG: null,
        priceMinor: 1299,
        freeOverMinor: null,
      },
    ],
  },
  {
    code: 'US',
    name: 'United States',
    countries: ['US'],
    regions: null,
    priority: 20,
    rates: [
      {
        code: 'standard',
        name: 'Standard (3–5 days)',
        minWeightG: 0,
        maxWeightG: 1000,
        priceMinor: 599,
        freeOverMinor: 7500,
      },
      {
        code: 'standard',
        name: 'Standard (3–5 days)',
        minWeightG: 1000,
        maxWeightG: null,
        priceMinor: 999,
        freeOverMinor: 7500,
      },
      {
        code: 'express',
        name: 'Express (next day)',
        minWeightG: 0,
        maxWeightG: null,
        priceMinor: 1999,
        freeOverMinor: null,
      },
    ],
  },
  {
    code: 'EU',
    name: 'European Union',
    countries: ['DE', 'FR', 'NL', 'IT', 'ES', 'BE', 'AT', 'IE'],
    regions: null,
    priority: 20,
    rates: [
      {
        code: 'standard',
        name: 'Standard (5–8 days)',
        minWeightG: 0,
        maxWeightG: 1000,
        priceMinor: 899,
        freeOverMinor: null,
      },
      {
        code: 'standard',
        name: 'Standard (5–8 days)',
        minWeightG: 1000,
        maxWeightG: null,
        priceMinor: 1499,
        freeOverMinor: null,
      },
      {
        code: 'express',
        name: 'Express (2–3 days)',
        minWeightG: 0,
        maxWeightG: null,
        priceMinor: 2499,
        freeOverMinor: null,
      },
    ],
  },
  {
    code: 'ROW',
    name: 'Rest of world',
    countries: [],
    regions: null,
    priority: 0,
    rates: [
      // Deliberately one band and one service level. The catch-all zone is the
      // one most likely to be hit by a destination nobody anticipated, and a
      // single unbanded rate cannot have a gap in it.
      {
        code: 'standard',
        name: 'International (7–14 days)',
        minWeightG: 0,
        maxWeightG: null,
        priceMinor: 1999,
        freeOverMinor: null,
      },
    ],
  },
];

async function seed(): Promise<void> {
  await AppDataSource.initialize();

  const zones = AppDataSource.getRepository(ShippingZoneEntity);
  const rates = AppDataSource.getRepository(ShippingRateEntity);
  const currency = process.env.SHIPPING_CURRENCY ?? 'USD';

  for (const { rates: rateRows, ...zone } of ZONES) {
    const existing = await zones.findOne({ where: { code: zone.code } });
    const saved = await zones.save(existing ? { ...existing, ...zone } : zones.create(zone));

    console.log(
      `  zone ${saved.code.padEnd(6)} priority ${String(saved.priority).padStart(2)} ` +
        `${saved.countries.length === 0 ? '(any country)' : saved.countries.join(',')}` +
        `${saved.regions ? ` / ${saved.regions.join(',')}` : ''}`,
    );

    for (const rate of rateRows) {
      // The natural key is exactly the unique index in the migration: one band
      // per service level per zone can start at a given weight.
      const existingRate = await rates.findOne({
        where: { zoneId: saved.id, code: rate.code, minWeightG: rate.minWeightG },
      });

      const row = { ...rate, zoneId: saved.id, currency };
      await rates.save(existingRate ? { ...existingRate, ...row } : rates.create(row));

      const band =
        rate.maxWeightG === null
          ? `${rate.minWeightG}g+`
          : `${rate.minWeightG}-${rate.maxWeightG}g`;
      console.log(
        `    ${rate.code.padEnd(8)} ${band.padEnd(12)} ${(rate.priceMinor / 100).toFixed(2)}` +
          `${rate.freeOverMinor ? ` (free over ${(rate.freeOverMinor / 100).toFixed(2)})` : ''}`,
      );
    }
  }

  await AppDataSource.destroy();
  console.log('Shipping seed complete.');
}

seed().catch((error) => {
  console.error('Shipping seed failed:', error);
  process.exit(1);
});
