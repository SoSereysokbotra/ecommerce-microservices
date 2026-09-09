/**
 * The pricing calculator.
 *
 * This is the one piece of M8 with real decisions in it, so — exactly like
 * `cart-merge.ts` in M7 — it is a pure function: no database, no HTTP, no clock.
 * Tax rules, promotions and the current time are all arguments. That is what
 * makes the table of cases in docs/M8_PRICING_PLAN.md §9 testable without
 * standing anything up.
 *
 * It deals only in ids, quantities, prices and categories. Names and SKUs are
 * presentation, and are merged back in by PricingService from the catalog
 * response; keeping them out of here means the arithmetic has nothing to hide
 * behind.
 *
 * THE RULE THAT MATTERS: tax is rounded **once per tax rate group**, never per
 * line. A basket whose lines carry different rates has no single "end" to round
 * at, and rounding per line and summing gives a different — sometimes larger,
 * sometimes smaller — answer. Measured on this project's own seeded prices at
 * 7.25%:
 *
 *     unit  qty   per-line sum   per-group   diff
 *      600   x6        264          261       +3
 *     1250   x6        546          544       +2
 *     2250   x6        978          979       -1
 *
 * Per-line tax figures still exist, because orders stores them — but they are
 * an *allocation* of the group's single rounded number, so they always sum back
 * to it. Do not "simplify" that into rounding each line directly.
 */

import { allocate, applyRate } from './money';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface Destination {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** State or province code, or null for "anywhere in the country". */
  region: string | null;
}

export interface QuoteLineInput {
  productId: string;
  qty: number;
  unitPriceMinor: number;
  /** Catalog category slug. Null when the product has no category. */
  category: string | null;
}

export interface TaxRule {
  /**
   * Whether this jurisdiction taxes delivery. Read only off the **general**
   * rule for a destination (`category === null`) — delivery has no product
   * category, so a category exemption says nothing about it.
   */
  shippingTaxable?: boolean;
  country: string;
  /** Null matches the whole country. */
  region: string | null;
  /** Null matches every category. */
  category: string | null;
  rateBp: number;
  /**
   * Whether catalog prices already contain this tax.
   *
   * US sales tax is added to the shelf price; EU and UK VAT is already inside
   * it. Same rate, different total — see docs/M8_PRICING_PLAN.md §7.
   */
  pricesIncludeTax: boolean;
  name: string;
}

export type DiscountType = 'percentage' | 'fixed';
export type DiscountScope = 'order' | 'category' | 'product';

export interface DiscountRule {
  id: string;
  name: string;
  type: DiscountType;
  /** Basis points, for `percentage`. */
  valueBp: number | null;
  /** Minor units, for `fixed`. */
  valueMinor: number | null;
  scope: DiscountScope;
  /** Category slug or product id, depending on `scope`. Null for `order`. */
  scopeRef: string | null;
  minSubtotalMinor: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

export interface QuoteInput {
  currency: string;
  destination: Destination;
  lines: readonly QuoteLineInput[];
  taxRules: readonly TaxRule[];
  discounts: readonly DiscountRule[];
  /**
   * What delivery costs, when a rate has been chosen.
   *
   * Deliberately just a number. Whether it is *taxed* is not the caller's
   * decision — it comes off the destination's general tax rule, in here, beside
   * every other tax decision. A caller that could pass `taxable: false` could
   * accidentally under-collect, and the rule already knows the answer.
   *
   * Absent or zero means no shipping line: a basket priced before an address is
   * known, or a rate that came out free.
   */
  shipping?: { costMinor: number } | null;

  /** Passed in rather than read, so promotion windows are testable. */
  now: Date;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface QuotedLine {
  productId: string;
  qty: number;
  unitPriceMinor: number;
  /** `unitPriceMinor * qty`. Exact; nothing has been rounded yet. */
  lineSubtotalMinor: number;
  /** This line's share of every discount that applied to it. */
  lineDiscountMinor: number;
  /** What tax is charged on: subtotal less discount. */
  taxableMinor: number;
  taxRateBp: number;
  /** This line's share of its group's tax. Never independently rounded. */
  taxMinor: number;
}

export interface TaxGroup {
  rateBp: number;
  pricesIncludeTax: boolean;
  /** Sum of the group's taxable amounts, exact. */
  baseMinor: number;
  /** Rounded exactly once, here. */
  taxMinor: number;
}

export interface AppliedDiscount {
  id: string;
  name: string;
  amountMinor: number;
}

export interface Quote {
  currency: string;
  destination: Destination;
  lines: QuotedLine[];
  /** Sum of the line subtotals, before any discount or tax. */
  subtotalMinor: number;
  discountMinor: number;
  appliedDiscounts: AppliedDiscount[];
  taxBreakdown: TaxGroup[];
  taxMinor: number;
  /**
   * What delivery costs, as charged — the same convention as `subtotalMinor`.
   * In an inclusive-tax region this already contains its VAT, exactly as the
   * line prices do. Zero when no rate applied or the basket earned free
   * shipping.
   */
  shippingMinor: number;

  /**
   * Shipping's share of `taxMinor`.
   *
   * An *allocation* of its tax group's single rounded figure, never rounded
   * independently — the same rule the per-line tax figures follow, for the same
   * reason (ADR-0007). Zero where the destination does not tax delivery.
   */
  shippingTaxMinor: number;

  /** The amount excluding tax. Differs from subtotal−discount only where prices include tax. */
  netMinor: number;
  /** What the customer pays. */
  totalMinor: number;
}

// ---------------------------------------------------------------------------
// Tax rate resolution
// ---------------------------------------------------------------------------

/**
 * Most specific rule wins:
 *
 *   (country, region, category) > (country, region, null)
 *                              > (country, null,   category)
 *                              > (country, null,   null)
 *                              > no match -> 0%
 *
 * "No match is 0%" is a decision, not an oversight. Rejecting a quote because
 * we have no rule for somewhere would be a worse shop than charging no tax
 * there, and the 0% shows up as an explicit group in `taxBreakdown` rather than
 * being silently absent.
 */
export function resolveTaxRule(
  rules: readonly TaxRule[],
  destination: Destination,
  category: string | null,
): TaxRule | null {
  const candidates = rules.filter(
    (rule) =>
      rule.country === destination.country &&
      (rule.region === null || rule.region === destination.region) &&
      (rule.category === null || rule.category === category),
  );

  if (candidates.length === 0) {
    return null;
  }

  const specificity = (rule: TaxRule): number =>
    (rule.region === null ? 0 : 2) + (rule.category === null ? 0 : 1);

  return candidates.reduce((best, rule) => (specificity(rule) > specificity(best) ? rule : best));
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

function isLive(discount: DiscountRule, now: Date): boolean {
  if (!discount.active) return false;
  if (discount.startsAt && now < discount.startsAt) return false;
  if (discount.endsAt && now > discount.endsAt) return false;
  return true;
}

function matchesScope(discount: DiscountRule, line: QuoteLineInput): boolean {
  switch (discount.scope) {
    case 'order':
      return true;
    case 'category':
      return line.category !== null && line.category === discount.scopeRef;
    case 'product':
      return line.productId === discount.scopeRef;
  }
}

/**
 * Promotions are applied in a deterministic order: every percentage discount,
 * then every fixed one, each against what is *left* after the ones before it.
 *
 * The order is arbitrary but it must be fixed, because 10% off then $5 off is
 * not the same amount as $5 off then 10% — and "whichever row the database
 * returned first" is not an answer. Ties within a type break on id so two runs
 * over the same data agree.
 *
 * Because each discount is computed against the remaining amount, the total can
 * never exceed the subtotal and no line can go negative. That is a property of
 * the algorithm rather than a clamp bolted on afterwards.
 */
function orderDiscounts(discounts: readonly DiscountRule[]): DiscountRule[] {
  const rank = (d: DiscountRule): number => (d.type === 'percentage' ? 0 : 1);
  return [...discounts].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

export function computeQuote(input: QuoteInput): Quote {
  const { lines, taxRules, destination, currency, now } = input;

  // 1. Line subtotals. Integer multiplication — exact, nothing to round.
  const subtotals = lines.map((line) => line.unitPriceMinor * line.qty);
  const subtotalMinor = subtotals.reduce((a, b) => a + b, 0);

  // 2. Discounts, allocated down onto the lines. A line is taxed on what that
  //    line actually cost, so this has to happen before any tax is computed.
  const lineDiscounts = subtotals.map(() => 0);
  const appliedDiscounts: AppliedDiscount[] = [];

  for (const discount of orderDiscounts(input.discounts)) {
    if (!isLive(discount, now)) continue;

    // Checked against the original subtotal, not the discounted one: "$5 off
    // orders over $50" is a statement about the basket, not about what is left
    // of it after an earlier promotion.
    if (subtotalMinor < discount.minSubtotalMinor) continue;

    // Weight every line by what remains of it, so a line already discounted to
    // nothing cannot be discounted again.
    const weights = lines.map((line, i) =>
      matchesScope(discount, line) ? subtotals[i] - lineDiscounts[i] : 0,
    );
    const base = weights.reduce((a, b) => a + b, 0);
    if (base === 0) continue;

    const amountMinor =
      discount.type === 'percentage'
        ? applyRate(base, discount.valueBp ?? 0)
        : Math.min(discount.valueMinor ?? 0, base);

    if (amountMinor <= 0) continue;

    allocate(amountMinor, weights).forEach((part, i) => {
      lineDiscounts[i] += part;
    });
    appliedDiscounts.push({ id: discount.id, name: discount.name, amountMinor });
  }

  const discountMinor = lineDiscounts.reduce((a, b) => a + b, 0);
  const taxables = subtotals.map((subtotal, i) => subtotal - lineDiscounts[i]);

  // 3. Group the lines by the rate that applies to them. The group, not the
  //    line, is the unit that gets rounded.
  //
  //    Grouping on inclusivity as well as rate is defensive: a region's rules
  //    should agree, but if a data error made them disagree the total is still
  //    coherent — each group contributes its own net and tax — rather than
  //    silently applying one line's convention to another's.
  interface Group {
    rateBp: number;
    pricesIncludeTax: boolean;
    baseMinor: number;
    lineIndexes: number[];
    /**
     * Delivery's contribution to this group, if delivery is taxed at this rate.
     *
     * Shipping joins an **existing** group rather than forming one of its own,
     * which is the whole reason this is cheap. "Round once per tax rate group"
     * (ADR-0007) means once per *rate*: giving shipping a private group at the
     * same rate as the goods would round 7.25% twice in one basket and put two
     * identical rows in the breakdown. It is one more weight in the allocation,
     * not a second calculation.
     */
    shippingBaseMinor: number;
  }
  const groups = new Map<string, Group>();
  const lineRates: number[] = [];

  lines.forEach((line, i) => {
    const rule = resolveTaxRule(taxRules, destination, line.category);
    const rateBp = rule?.rateBp ?? 0;
    const pricesIncludeTax = rule?.pricesIncludeTax ?? false;
    lineRates[i] = rateBp;

    const key = `${rateBp}:${pricesIncludeTax}`;
    const group = groups.get(key) ?? {
      rateBp,
      pricesIncludeTax,
      baseMinor: 0,
      lineIndexes: [],
      shippingBaseMinor: 0,
    };
    group.baseMinor += taxables[i];
    group.lineIndexes.push(i);
    groups.set(key, group);
  });

  /**
   * 3b. Delivery joins the group for its own rate.
   *
   * The rate comes from the destination's **general** rule — `category: null` —
   * because delivery is not a product and has no category. Pennsylvania exempts
   * clothing and still taxes the postage on it.
   *
   * A destination that does not tax delivery puts it in the 0% group, which is
   * a real group and shows up in `taxBreakdown`. M8 made the same choice for
   * goods with no matching rule: an explicit 0% is inspectable, a silent
   * absence is a bug that looks like a feature.
   */
  const shippingMinor = input.shipping?.costMinor ?? 0;

  if (shippingMinor > 0) {
    const generalRule = resolveTaxRule(taxRules, destination, null);
    const taxed = generalRule !== null && generalRule.shippingTaxable !== false;
    const rateBp = taxed ? generalRule.rateBp : 0;
    const pricesIncludeTax = taxed ? generalRule.pricesIncludeTax : false;

    const key = `${rateBp}:${pricesIncludeTax}`;
    const group = groups.get(key) ?? {
      rateBp,
      pricesIncludeTax,
      baseMinor: 0,
      lineIndexes: [],
      shippingBaseMinor: 0,
    };
    group.baseMinor += shippingMinor;
    group.shippingBaseMinor += shippingMinor;
    groups.set(key, group);
  }

  // 4. Round once per group, then divide that one figure across the group's
  //    lines. Never the other way round.
  const lineTaxes = subtotals.map(() => 0);
  const taxBreakdown: TaxGroup[] = [];
  let taxMinor = 0;
  let netMinor = 0;
  let shippingTaxMinor = 0;

  for (const group of groups.values()) {
    const groupTax = group.pricesIncludeTax
      ? // The base is gross: back the tax out of it rather than adding to it.
        applyRate(group.baseMinor, group.rateBp, 10000 + group.rateBp)
      : applyRate(group.baseMinor, group.rateBp);

    /**
     * Delivery is the last weight in the split, when it belongs to this group.
     *
     * So its tax is an **allocation** of the group's one rounded figure, on
     * exactly the same footing as a line's — not a second rounding. The parts
     * still sum to `groupTax` by construction, which is the property that makes
     * per-line figures add back up to the total.
     */
    const weights = group.lineIndexes.map((i) => taxables[i]);
    if (group.shippingBaseMinor > 0) {
      weights.push(group.shippingBaseMinor);
    }

    const parts = allocate(groupTax, weights);

    group.lineIndexes.forEach((lineIndex, n) => {
      lineTaxes[lineIndex] = parts[n];
    });
    if (group.shippingBaseMinor > 0) {
      shippingTaxMinor += parts[group.lineIndexes.length];
    }

    taxMinor += groupTax;
    netMinor += group.pricesIncludeTax ? group.baseMinor - groupTax : group.baseMinor;

    taxBreakdown.push({
      rateBp: group.rateBp,
      pricesIncludeTax: group.pricesIncludeTax,
      baseMinor: group.baseMinor,
      taxMinor: groupTax,
    });
  }

  // Highest rate first, so the line a customer is most likely to query is at the
  // top. Ordering is presentation only; the arithmetic above does not depend on it.
  taxBreakdown.sort((a, b) => b.rateBp - a.rateBp);

  // 5. One addition of integers that were each already rounded exactly once.
  const totalMinor = netMinor + taxMinor;

  return {
    currency,
    destination,
    lines: lines.map((line, i) => ({
      productId: line.productId,
      qty: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      lineSubtotalMinor: subtotals[i],
      lineDiscountMinor: lineDiscounts[i],
      taxableMinor: taxables[i],
      taxRateBp: lineRates[i],
      taxMinor: lineTaxes[i],
    })),
    subtotalMinor,
    discountMinor,
    appliedDiscounts,
    taxBreakdown,
    taxMinor,
    shippingMinor,
    shippingTaxMinor,
    netMinor,
    totalMinor,
  };
}
