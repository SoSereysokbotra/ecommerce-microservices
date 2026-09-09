import 'reflect-metadata';
import { IsNull } from 'typeorm';
import { AppDataSource } from './typeorm.config';
import { TaxRateEntity } from '../modules/pricing/tax-rate.entity';
import { DiscountEntity, DiscountScope, DiscountType } from '../modules/pricing/discount.entity';
import { CouponEntity } from '../modules/coupons/coupon.entity';

/**
 * Idempotent seed — safe to re-run. Matches on the natural key and updates
 * rather than inserting duplicates, the same way the catalog seed does.
 *
 * The three regions are the ones docs/M8_PRICING_PLAN.md §7 argues for, chosen
 * because each adds a dimension the others do not and every fact is real:
 *
 *   US-CA  7.25% added on top of the price — the baseline.
 *   US-PA  6% added on top, but clothing is exempt. Same country as CA, so it
 *          exercises both the region and the category dimension.
 *   DE     19% already inside the price. Exercises the back-out arithmetic,
 *          which nothing else does.
 *
 * Prices stay in USD in all three. Tax region and currency are independent, and
 * multi-currency is M11 — doing FX here would mean solving zero-decimal
 * currencies in the same milestone as rounding.
 */
const TAX_RATES = [
  {
    country: 'US',
    region: 'CA',
    category: null,
    rateBp: 725,
    pricesIncludeTax: false,
    // California does not tax separately-stated delivery by common carrier.
    shippingTaxable: false,
    name: 'California sales tax',
  },
  {
    country: 'US',
    region: 'PA',
    category: null,
    rateBp: 600,
    pricesIncludeTax: false,
    // Pennsylvania does tax delivery when the goods are taxable. The opposite
    // of California, which is the point of seeding both.
    shippingTaxable: true,
    name: 'Pennsylvania sales tax',
  },
  {
    // Pennsylvania does not tax clothing. A narrower row wins over the one
    // above it for apparel, and only for apparel.
    country: 'US',
    region: 'PA',
    category: 'apparel',
    rateBp: 0,
    pricesIncludeTax: false,
    // Never consulted for shipping: only the general rule for a destination is,
    // because delivery has no product category. Set to match the general PA
    // rule so a future reader is not invited to infer meaning from a mismatch.
    shippingTaxable: true,
    name: 'Pennsylvania clothing exemption',
  },
  {
    country: 'DE',
    region: null,
    category: null,
    rateBp: 1900,
    pricesIncludeTax: true,
    // Delivery is ancillary to the supply: same rate as the goods, and the
    // price already includes it.
    shippingTaxable: true,
    name: 'German VAT',
  },
];

/**
 * Two promotions, deliberately neither of them a blanket "10% off everything".
 *
 * One is scoped to a category and one has a minimum spend, so a basket can
 * qualify for neither, either, or both — which is what makes the stacking rule
 * (percentage first, then fixed, each against what is left) observable rather
 * than theoretical.
 */
const DISCOUNTS = [
  {
    name: 'Drinkware 15%',
    code: null,
    type: DiscountType.PERCENTAGE,
    valueBp: 1500,
    valueMinor: null,
    scope: DiscountScope.CATEGORY,
    scopeRef: 'drinkware',
    minSubtotalMinor: 0,
    startsAt: null,
    endsAt: null,
    active: true,
  },
  {
    name: 'Spend $50, save $5',
    code: null,
    type: DiscountType.FIXED,
    valueBp: null,
    valueMinor: 500,
    scope: DiscountScope.ORDER,
    scopeRef: null,
    minSubtotalMinor: 5000,
    startsAt: null,
    endsAt: null,
    active: true,
  },
];

/**
 * Coupons, and the discounts they unlock.
 *
 * The discount rows are ordinary M8 promotions with one difference: they carry
 * a `code`, so `PricingService` must **exclude them** from the automatic set. A
 * coupon discount that also applied automatically would be a discount everyone
 * gets and nobody has to ask for.
 *
 * SAVE10USES exists for the concurrency test: ten uses, and the acceptance
 * criterion is that fifty simultaneous attempts yield exactly ten.
 */
const COUPONS = [
  {
    code: 'SAVE10USES',
    maxUses: 10,
    perCustomerLimit: 1,
    discount: {
      name: 'Coupon SAVE10USES — 10% off',
      code: 'SAVE10USES',
      type: DiscountType.PERCENTAGE,
      valueBp: 1000,
      valueMinor: null,
      scope: DiscountScope.ORDER,
      scopeRef: null,
      minSubtotalMinor: 0,
      startsAt: null,
      endsAt: null,
      active: true,
    },
  },
  {
    code: 'FIVEOFF',
    maxUses: null, // unlimited
    perCustomerLimit: null,
    discount: {
      name: 'Coupon FIVEOFF — $5 off',
      code: 'FIVEOFF',
      type: DiscountType.FIXED,
      valueBp: null,
      valueMinor: 500,
      scope: DiscountScope.ORDER,
      scopeRef: null,
      minSubtotalMinor: 2000,
      startsAt: null,
      endsAt: null,
      active: true,
    },
  },
];

async function seed(): Promise<void> {
  await AppDataSource.initialize();

  const taxRates = AppDataSource.getRepository(TaxRateEntity);
  const discounts = AppDataSource.getRepository(DiscountEntity);

  for (const rate of TAX_RATES) {
    // `region: null` has to be looked up as IS NULL, not `= NULL`, which is the
    // same reason the unique index in the migration coalesces before comparing.
    const existing = await taxRates.findOne({
      where: {
        country: rate.country,
        region: rate.region ?? IsNull(),
        category: rate.category ?? IsNull(),
      },
    });

    await taxRates.save(existing ? { ...existing, ...rate } : taxRates.create(rate));
    console.log(
      `  tax  ${rate.country}${rate.region ? `-${rate.region}` : ''}` +
        `${rate.category ? `/${rate.category}` : ''}: ${(rate.rateBp / 100).toFixed(2)}%` +
        `${rate.pricesIncludeTax ? ' (inclusive)' : ''}`,
    );
  }

  for (const discount of DISCOUNTS) {
    const existing = await discounts.findOne({ where: { name: discount.name } });

    await discounts.save(existing ? { ...existing, ...discount } : discounts.create(discount));
    console.log(`  promo ${discount.name}`);
  }

  const coupons = AppDataSource.getRepository(CouponEntity);

  for (const coupon of COUPONS) {
    const discounts2 = AppDataSource.getRepository(DiscountEntity);
    const existingDiscount = await discounts2.findOne({ where: { name: coupon.discount.name } });
    const saved = await discounts2.save(
      existingDiscount
        ? { ...existingDiscount, ...coupon.discount }
        : discounts2.create(coupon.discount),
    );

    const existing = await coupons.findOne({ where: { code: coupon.code } });
    // usedCount is deliberately NOT reset on re-seed: re-running the seed must
    // not hand back uses that customers have already taken.
    await coupons.save(
      existing
        ? { ...existing, maxUses: coupon.maxUses, perCustomerLimit: coupon.perCustomerLimit }
        : coupons.create({
            code: coupon.code,
            discountId: saved.id,
            maxUses: coupon.maxUses,
            perCustomerLimit: coupon.perCustomerLimit,
            usedCount: 0,
            active: true,
          }),
    );

    console.log(
      `  coupon ${coupon.code} (${coupon.maxUses ?? 'unlimited'} uses` +
        `${coupon.perCustomerLimit ? `, ${coupon.perCustomerLimit} per customer` : ''})`,
    );
  }

  await AppDataSource.destroy();
}

seed()
  .then(() => console.log('Pricing seed complete.'))
  .catch((error) => {
    console.error('Pricing seed failed:', error);
    process.exit(1);
  });
