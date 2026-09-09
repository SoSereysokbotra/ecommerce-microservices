import {
  computeQuote,
  resolveTaxRule,
  type DiscountRule,
  type QuoteInput,
  type QuoteLineInput,
  type TaxRule,
} from '../src/modules/pricing/quote';

// ---------------------------------------------------------------------------
// Fixtures — the three regions of docs/M8_PRICING_PLAN.md §7, and this
// project's own seeded catalog prices.
// ---------------------------------------------------------------------------

const US_CA: TaxRule[] = [
  {
    country: 'US',
    region: 'CA',
    category: null,
    rateBp: 725,
    pricesIncludeTax: false,
    // California does not tax separately-stated carrier delivery.
    shippingTaxable: false,
    name: 'California sales tax',
  },
];

const US_PA: TaxRule[] = [
  {
    country: 'US',
    region: 'PA',
    category: null,
    rateBp: 600,
    pricesIncludeTax: false,
    // Pennsylvania does. The opposite of California, deliberately.
    shippingTaxable: true,
    name: 'Pennsylvania sales tax',
  },
  {
    country: 'US',
    region: 'PA',
    category: 'apparel',
    rateBp: 0,
    pricesIncludeTax: false,
    shippingTaxable: true,
    name: 'Pennsylvania clothing exemption',
  },
];

const DE: TaxRule[] = [
  {
    country: 'DE',
    region: null,
    category: null,
    rateBp: 1900,
    pricesIncludeTax: true,
    // Delivery is ancillary to the supply: goods' rate, inside the price.
    shippingTaxable: true,
    name: 'German VAT',
  },
];

const ALL_RULES = [...US_CA, ...US_PA, ...DE];

/** 3 × Black Tee (M), 1 × Black Mug, 2 × USB-C Cable. Subtotal 10047. */
const BASKET: QuoteLineInput[] = [
  { productId: 'tee', qty: 3, unitPriceMinor: 1999, category: 'apparel' },
  { productId: 'mug', qty: 1, unitPriceMinor: 1250, category: 'drinkware' },
  { productId: 'cable', qty: 2, unitPriceMinor: 1400, category: 'accessories' },
];

const TEN_PERCENT: DiscountRule = {
  id: 'spring10',
  name: 'Spring 10%',
  type: 'percentage',
  valueBp: 1000,
  valueMinor: null,
  scope: 'order',
  scopeRef: null,
  minSubtotalMinor: 0,
  startsAt: null,
  endsAt: null,
  active: true,
};

const NOW = new Date('2026-09-04T12:00:00Z');

function quote(over: Partial<QuoteInput> = {}) {
  return computeQuote({
    currency: 'USD',
    destination: { country: 'US', region: 'CA' },
    lines: BASKET,
    taxRules: ALL_RULES,
    discounts: [],
    now: NOW,
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe('resolveTaxRule', () => {
  it('prefers the most specific match', () => {
    const apparel = resolveTaxRule(US_PA, { country: 'US', region: 'PA' }, 'apparel');
    const mug = resolveTaxRule(US_PA, { country: 'US', region: 'PA' }, 'drinkware');

    expect(apparel?.rateBp).toBe(0);
    expect(mug?.rateBp).toBe(600);
  });

  it('matches a country-wide rule when the region has none of its own', () => {
    expect(resolveTaxRule(DE, { country: 'DE', region: 'BY' }, 'apparel')?.rateBp).toBe(1900);
  });

  it('does not leak one region rule into another', () => {
    expect(resolveTaxRule(US_CA, { country: 'US', region: 'PA' }, 'apparel')).toBeNull();
  });

  it('returns null where there is no rule at all', () => {
    expect(resolveTaxRule(ALL_RULES, { country: 'KH', region: null }, 'apparel')).toBeNull();
  });
});

describe('computeQuote — the three regions (plan §9 worked example)', () => {
  it('US-CA: 7.25% exclusive on everything', () => {
    const q = quote({ discounts: [TEN_PERCENT] });

    expect(q.subtotalMinor).toBe(10047);
    expect(q.discountMinor).toBe(1005);
    expect(q.lines.map((l) => l.lineDiscountMinor)).toEqual([600, 125, 280]);
    expect(q.lines.map((l) => l.taxableMinor)).toEqual([5397, 1125, 2520]);

    expect(q.taxBreakdown).toEqual([
      { rateBp: 725, pricesIncludeTax: false, baseMinor: 9042, taxMinor: 656 },
    ]);
    expect(q.netMinor).toBe(9042);
    expect(q.taxMinor).toBe(656);
    expect(q.totalMinor).toBe(9698);
  });

  it('US-PA: 6% exclusive with apparel exempt — two groups, each rounded once', () => {
    const q = quote({
      destination: { country: 'US', region: 'PA' },
      discounts: [TEN_PERCENT],
    });

    expect(q.taxBreakdown).toEqual([
      { rateBp: 600, pricesIncludeTax: false, baseMinor: 3645, taxMinor: 219 },
      { rateBp: 0, pricesIncludeTax: false, baseMinor: 5397, taxMinor: 0 },
    ]);
    expect(q.taxMinor).toBe(219);
    expect(q.totalMinor).toBe(9261);

    // The exemption is visible per line, not just in the total.
    expect(q.lines[0].taxRateBp).toBe(0);
    expect(q.lines[0].taxMinor).toBe(0);
  });

  it('DE: 19% inclusive — the tax comes out of the price, not on top of it', () => {
    const q = quote({
      destination: { country: 'DE', region: null },
      discounts: [TEN_PERCENT],
    });

    expect(q.taxMinor).toBe(1444);
    expect(q.netMinor).toBe(7598);
    expect(q.totalMinor).toBe(9042);

    // The whole point of inclusive pricing: the customer pays the (discounted)
    // shelf price, and the tax was already inside it.
    expect(q.totalMinor).toBe(q.subtotalMinor - q.discountMinor);
    expect(q.netMinor + q.taxMinor).toBe(q.totalMinor);
  });
});

describe('computeQuote — rounding', () => {
  it('rounds once per group, not once per line (plan §3)', () => {
    // Six sticker packs at 600 in California. Rounding each of the six lines'
    // worth separately and summing gives 264; rounding the group gives 261.
    const q = quote({
      lines: [{ productId: 'sticker', qty: 6, unitPriceMinor: 600, category: 'accessories' }],
    });

    expect(q.taxMinor).toBe(261);
    expect(q.taxMinor).not.toBe(264);
    expect(q.totalMinor).toBe(3600 + 261);
  });

  it('splits a group tax across its lines so the parts sum back to it', () => {
    const q = quote();

    for (const group of q.taxBreakdown) {
      const linesInGroup = q.lines.filter((l) => l.taxRateBp === group.rateBp);
      expect(linesInGroup.reduce((sum, l) => sum + l.taxMinor, 0)).toBe(group.taxMinor);
    }
    expect(q.lines.reduce((sum, l) => sum + l.taxMinor, 0)).toBe(q.taxMinor);
  });

  it('charges plain tax on top when there is no discount', () => {
    const q = quote({ lines: [BASKET[1]] }); // one mug, 1250

    expect(q.subtotalMinor).toBe(1250);
    expect(q.taxMinor).toBe(91); // 7.25% of 1250 is 90.625
    expect(q.totalMinor).toBe(1341);
  });
});

describe('computeQuote — discounts', () => {
  it('allocates an order discount across lines so the parts sum exactly', () => {
    const q = quote({ discounts: [TEN_PERCENT] });

    expect(q.lines.reduce((sum, l) => sum + l.lineDiscountMinor, 0)).toBe(q.discountMinor);
    expect(q.appliedDiscounts).toEqual([{ id: 'spring10', name: 'Spring 10%', amountMinor: 1005 }]);
  });

  it('confines a category discount to that category', () => {
    const q = quote({
      discounts: [
        {
          ...TEN_PERCENT,
          id: 'drinkware15',
          scope: 'category',
          scopeRef: 'drinkware',
          valueBp: 1500,
        },
      ],
    });

    expect(q.lines[0].lineDiscountMinor).toBe(0); // apparel
    expect(q.lines[1].lineDiscountMinor).toBe(188); // 15% of 1250 = 187.5
    expect(q.lines[2].lineDiscountMinor).toBe(0); // accessories
    expect(q.discountMinor).toBe(188);
  });

  it('confines a product discount to that product', () => {
    const q = quote({
      discounts: [{ ...TEN_PERCENT, id: 'tee10', scope: 'product', scopeRef: 'tee' }],
    });

    expect(q.lines.map((l) => l.lineDiscountMinor)).toEqual([600, 0, 0]); // 10% of 5997 = 599.7
  });

  it('stacks percentage before fixed, whatever order they arrive in', () => {
    const line = [{ productId: 'x', qty: 1, unitPriceMinor: 10000, category: null }];
    const fixed: DiscountRule = {
      ...TEN_PERCENT,
      id: 'fiver',
      type: 'fixed',
      valueBp: null,
      valueMinor: 500,
    };

    const a = quote({ lines: line, discounts: [TEN_PERCENT, fixed] });
    const b = quote({ lines: line, discounts: [fixed, TEN_PERCENT] });

    // 10% of 10000 = 1000, then $5 off what is left = 500. Total 1500.
    expect(a.discountMinor).toBe(1500);
    expect(a.appliedDiscounts.map((d) => d.id)).toEqual(['spring10', 'fiver']);
    expect(b).toEqual(a);
  });

  it('caps a fixed discount at the subtotal — a basket never costs less than nothing', () => {
    const q = quote({
      lines: [BASKET[1]], // 1250
      discounts: [
        { ...TEN_PERCENT, id: 'huge', type: 'fixed', valueBp: null, valueMinor: 999_999 },
      ],
    });

    expect(q.discountMinor).toBe(1250);
    expect(q.taxMinor).toBe(0);
    expect(q.totalMinor).toBe(0);
  });

  it('skips a promotion whose minimum subtotal is not met', () => {
    const q = quote({ discounts: [{ ...TEN_PERCENT, minSubtotalMinor: 20_000 }] });

    expect(q.discountMinor).toBe(0);
    expect(q.appliedDiscounts).toEqual([]);
  });

  it('checks the minimum against the original subtotal, not what an earlier discount left', () => {
    // Subtotal 10047: the first promotion takes it below 10000, and the second
    // must still apply because the basket did qualify.
    const q = quote({
      discounts: [TEN_PERCENT, { ...TEN_PERCENT, id: 'second', minSubtotalMinor: 10_000 }],
    });

    expect(q.appliedDiscounts).toHaveLength(2);
  });

  it('skips promotions outside their window, and inactive ones', () => {
    const expired = { ...TEN_PERCENT, id: 'expired', endsAt: new Date('2026-01-01T00:00:00Z') };
    const future = { ...TEN_PERCENT, id: 'future', startsAt: new Date('2027-01-01T00:00:00Z') };
    const off = { ...TEN_PERCENT, id: 'off', active: false };

    expect(quote({ discounts: [expired, future, off] }).discountMinor).toBe(0);
  });

  it('applies a promotion inside its window', () => {
    const live = {
      ...TEN_PERCENT,
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-09-30T00:00:00Z'),
    };

    expect(quote({ discounts: [live] }).discountMinor).toBe(1005);
  });
});

describe('computeQuote — edges', () => {
  it('quotes an empty basket as zeros rather than failing', () => {
    const q = quote({ lines: [], discounts: [TEN_PERCENT] });

    expect(q.subtotalMinor).toBe(0);
    expect(q.discountMinor).toBe(0);
    expect(q.taxMinor).toBe(0);
    expect(q.totalMinor).toBe(0);
    expect(q.taxBreakdown).toEqual([]);
    expect(q.appliedDiscounts).toEqual([]);
  });

  it('still quotes where no tax rule exists, as an explicit 0% group', () => {
    const q = quote({ destination: { country: 'KH', region: null } });

    expect(q.taxMinor).toBe(0);
    expect(q.totalMinor).toBe(q.subtotalMinor);
    expect(q.taxBreakdown).toEqual([
      { rateBp: 0, pricesIncludeTax: false, baseMinor: 10047, taxMinor: 0 },
    ]);
  });

  it('treats a product with no category as the country-wide rate', () => {
    const q = quote({
      destination: { country: 'US', region: 'PA' },
      lines: [{ productId: 'odd', qty: 1, unitPriceMinor: 1000, category: null }],
    });

    expect(q.lines[0].taxRateBp).toBe(600);
  });
});

describe('computeQuote — invariants over many random baskets', () => {
  // A deterministic PRNG rather than a property-testing library: the plan called
  // for a property test, and this gets the same coverage of inputs nobody
  // thought to write down without adding a dependency. The seed is fixed, so a
  // failure here is reproducible rather than a flake.
  function prng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  it('holds every accounting identity', () => {
    const rand = prng(20260904);
    const categories = ['apparel', 'drinkware', 'accessories', null];
    const destinations = [
      { country: 'US', region: 'CA' },
      { country: 'US', region: 'PA' },
      { country: 'DE', region: null },
      { country: 'KH', region: null },
    ];

    for (let run = 0; run < 500; run++) {
      const lines: QuoteLineInput[] = [];
      const lineCount = 1 + Math.floor(rand() * 5);

      for (let i = 0; i < lineCount; i++) {
        lines.push({
          productId: `p${i}`,
          qty: 1 + Math.floor(rand() * 9),
          unitPriceMinor: 1 + Math.floor(rand() * 20_000),
          category: categories[Math.floor(rand() * categories.length)],
        });
      }

      const discounts: DiscountRule[] = [];
      if (rand() < 0.7) {
        discounts.push({ ...TEN_PERCENT, valueBp: 1 + Math.floor(rand() * 9999) });
      }
      if (rand() < 0.5) {
        discounts.push({
          ...TEN_PERCENT,
          id: 'fixed',
          type: 'fixed',
          valueBp: null,
          valueMinor: Math.floor(rand() * 30_000),
        });
      }

      const q = computeQuote({
        currency: 'USD',
        destination: destinations[Math.floor(rand() * destinations.length)],
        lines,
        taxRules: ALL_RULES,
        discounts,
        now: NOW,
      });

      const context = JSON.stringify({ lines, discounts, destination: q.destination });

      // Nothing is invented or lost when a discount is pushed onto the lines.
      expect(`${q.lines.reduce((s, l) => s + l.lineDiscountMinor, 0)} ${context}`).toBe(
        `${q.discountMinor} ${context}`,
      );
      // Nor when a group's single rounded tax is pushed onto its lines.
      expect(`${q.lines.reduce((s, l) => s + l.taxMinor, 0)} ${context}`).toBe(
        `${q.taxMinor} ${context}`,
      );
      expect(`${q.taxBreakdown.reduce((s, g) => s + g.taxMinor, 0)} ${context}`).toBe(
        `${q.taxMinor} ${context}`,
      );
      // Every taxable amount is accounted for by exactly one group.
      expect(`${q.taxBreakdown.reduce((s, g) => s + g.baseMinor, 0)} ${context}`).toBe(
        `${q.lines.reduce((s, l) => s + l.taxableMinor, 0)} ${context}`,
      );
      // The total is net plus tax, and nothing else.
      expect(`${q.netMinor + q.taxMinor} ${context}`).toBe(`${q.totalMinor} ${context}`);

      // No amount is ever negative, and no line is discounted past free.
      expect(q.discountMinor).toBeLessThanOrEqual(q.subtotalMinor);
      expect(q.totalMinor).toBeGreaterThanOrEqual(0);
      for (const line of q.lines) {
        expect(line.lineDiscountMinor).toBeLessThanOrEqual(line.lineSubtotalMinor);
        expect(line.taxableMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M10 — delivery in the total
//
// Every figure below was computed by hand from the fixtures before it was run,
// which is the method M8 used and the reason its rounding bug was caught rather
// than blessed. The basket is the same one M8 argued about: 3 tees, 1 mug,
// 2 cables, subtotal 10047.
//
// The rule being defended: **round once per tax rate**. Delivery joins the
// group for its own rate rather than forming a private one, so a basket taxed
// at 7.25% rounds 7.25% exactly once even though goods and postage are two
// different kinds of thing.
// ---------------------------------------------------------------------------

describe('shipping in the quote', () => {
  describe('US-CA — 7.25% on goods, delivery NOT taxable', () => {
    // Goods:    10047 @ 725bp -> 10047 * 725 / 10000 = 728.4075 -> 728
    // Delivery:   699 @   0bp -> 0, in its own explicit 0% group
    // net = 10047 + 699 = 10746;  total = 10746 + 728 = 11474
    const result = quote({ shipping: { costMinor: 699 } });

    it('adds delivery to the total without taxing it', () => {
      expect(result.shippingMinor).toBe(699);
      expect(result.shippingTaxMinor).toBe(0);
      expect(result.taxMinor).toBe(728);
      expect(result.netMinor).toBe(10746);
      expect(result.totalMinor).toBe(11474);
    });

    it('shows the untaxed delivery as an explicit 0% group, not as an absence', () => {
      // Same choice M8 made for goods with no matching rule: an explicit 0% is
      // inspectable, a silent absence is a bug that looks like a feature.
      const zeroGroup = result.taxBreakdown.find((g) => g.rateBp === 0);
      expect(zeroGroup).toMatchObject({ baseMinor: 699, taxMinor: 0 });
    });

    it('leaves the goods group untouched by delivery', () => {
      expect(result.taxBreakdown.find((g) => g.rateBp === 725)).toMatchObject({
        baseMinor: 10047,
        taxMinor: 728,
      });
    });
  });

  describe('US-PA — 6%, apparel exempt, delivery IS taxable', () => {
    // Lines:  tee 5997 @ 0bp (apparel exemption)
    //         mug 1250 + cable 2800 = 4050 @ 600bp
    // Delivery 599 is taxed at the GENERAL rule (600bp) — the apparel exemption
    // says nothing about postage — so it joins the 600bp group:
    //         base 4050 + 599 = 4649 -> 4649 * 600 / 10000 = 278.94 -> 279
    // Allocating 279 across [1250, 2800, 599] by largest remainder:
    //         75 + 168 + 35 = 278, one penny left, largest remainder is
    //         delivery (4406/4649) -> delivery takes it -> 36
    // net = 5997 + 4649 = 10646;  total = 10646 + 279 = 10925
    const result = quote({
      destination: { country: 'US', region: 'PA' },
      shipping: { costMinor: 599 },
    });

    it('taxes delivery at the general rate, not the category rate', () => {
      expect(result.shippingMinor).toBe(599);
      expect(result.shippingTaxMinor).toBe(36);
      expect(result.taxMinor).toBe(279);
      expect(result.totalMinor).toBe(10925);
    });

    it('rounds the rate ONCE across goods and delivery together', () => {
      // The point of joining an existing group rather than making a new one:
      // there is only one 6% in Pennsylvania, so there is one 6% row and one
      // rounding, whatever mixture of goods and postage produced the base.
      const sixPercent = result.taxBreakdown.filter((g) => g.rateBp === 600);
      expect(sixPercent).toHaveLength(1);
      expect(sixPercent[0]).toMatchObject({ baseMinor: 4649, taxMinor: 279 });
    });

    it('keeps the apparel exemption at 0% with delivery kept out of it', () => {
      expect(result.taxBreakdown.find((g) => g.rateBp === 0)).toMatchObject({
        baseMinor: 5997,
        taxMinor: 0,
      });
    });
  });

  describe('DE — 19% already inside the price, delivery included the same way', () => {
    // One group, 1900bp inclusive: base 10047 + 899 = 10946
    //   tax = 10946 * 1900 / 11900 = 1747.4... -> 1748   (backed OUT, not added)
    //   net = 10946 - 1748 = 9198;  total = 9198 + 1748 = 10946
    // Delivery's share of 1748, allocated across [5997, 1250, 2800, 899]: 143.
    const result = quote({
      destination: { country: 'DE', region: null },
      shipping: { costMinor: 899 },
    });

    it('backs the tax OUT of the delivery price rather than adding it on top', () => {
      // The whole inclusive/exclusive distinction, applied to postage for free:
      // the total equals the gross of goods plus delivery, unchanged.
      expect(result.shippingMinor).toBe(899);
      expect(result.totalMinor).toBe(10946);
      expect(result.taxMinor).toBe(1748);
      expect(result.netMinor).toBe(9198);
    });

    it('gives delivery its share of the one rounded figure', () => {
      expect(result.shippingTaxMinor).toBe(143);
    });

    it('puts goods and delivery in a single inclusive group', () => {
      expect(result.taxBreakdown).toHaveLength(1);
      expect(result.taxBreakdown[0]).toMatchObject({
        rateBp: 1900,
        pricesIncludeTax: true,
        baseMinor: 10946,
        taxMinor: 1748,
      });
    });
  });

  describe('invariants that hold whatever the region', () => {
    const cases = [
      { name: 'US-CA', over: { shipping: { costMinor: 699 } } },
      {
        name: 'US-PA',
        over: { destination: { country: 'US', region: 'PA' }, shipping: { costMinor: 599 } },
      },
      {
        name: 'DE',
        over: { destination: { country: 'DE', region: null }, shipping: { costMinor: 899 } },
      },
    ];

    it.each(cases)('$name: total equals net plus tax', ({ over }) => {
      const result = quote(over);
      expect(result.totalMinor).toBe(result.netMinor + result.taxMinor);
    });

    it.each(cases)('$name: the tax groups sum to taxMinor', ({ over }) => {
      const result = quote(over);
      const summed = result.taxBreakdown.reduce((a, g) => a + g.taxMinor, 0);
      expect(summed).toBe(result.taxMinor);
    });

    it.each(cases)('$name: delivery tax is within the total tax', ({ over }) => {
      const result = quote(over);
      expect(result.shippingTaxMinor).toBeLessThanOrEqual(result.taxMinor);
      expect(result.shippingTaxMinor).toBeGreaterThanOrEqual(0);
    });

    it.each(cases)('$name: per-line taxes plus delivery tax equal taxMinor', ({ over }) => {
      // The property that makes a receipt add up. If delivery were rounded
      // separately from its group, this is the assertion that would break.
      const result = quote(over);
      const lineTax = result.lines.reduce((a, l) => a + l.taxMinor, 0);
      expect(lineTax + result.shippingTaxMinor).toBe(result.taxMinor);
    });
  });

  describe('when delivery costs nothing', () => {
    it('is identical to a quote with no shipping at all', () => {
      // Free shipping must not invent a zero-base tax group or shift a penny.
      const free = quote({ shipping: { costMinor: 0 } });
      const none = quote();
      expect(free).toEqual(none);
      expect(free.shippingMinor).toBe(0);
      expect(free.shippingTaxMinor).toBe(0);
    });
  });

  describe('discounts and delivery', () => {
    // Goods 10047, 10% off -> 1004.7 -> 1005. Taxable goods 9042.
    //   goods tax  = 9042 * 725 / 10000 = 655.545 -> 656
    //   delivery 699 untaxed in US-CA
    //   net = 9042 + 699 = 9741;  total = 9741 + 656 = 10397
    const result = quote({ discounts: [TEN_PERCENT], shipping: { costMinor: 699 } });

    it('never discounts delivery', () => {
      // "Free shipping over $50" is a rate rule, not a discount — it belongs in
      // shipping-service's table. Keeping it out of discountMinor leaves that
      // field meaning exactly one thing: money off the goods.
      expect(result.discountMinor).toBe(1005);
      expect(result.shippingMinor).toBe(699);
      expect(result.taxMinor).toBe(656);
      expect(result.totalMinor).toBe(10397);
    });
  });

  describe('a destination with no tax rule at all', () => {
    it('still prices delivery, at 0%', () => {
      // KH has no rules. M8 decided no match is 0% rather than a rejection;
      // delivery follows the goods into the same explicit 0% group.
      const result = quote({
        destination: { country: 'KH', region: null },
        shipping: { costMinor: 1999 },
      });
      expect(result.taxMinor).toBe(0);
      expect(result.shippingMinor).toBe(1999);
      expect(result.shippingTaxMinor).toBe(0);
      expect(result.totalMinor).toBe(10047 + 1999);
      expect(result.taxBreakdown).toHaveLength(1);
      expect(result.taxBreakdown[0]).toMatchObject({ rateBp: 0, baseMinor: 12046 });
    });
  });
});
