/**
 * How many minor units Stripe expects, per currency.
 *
 * Stripe's API takes an amount in **the smallest currency unit** — 2000 is
 * $20.00, but 2000 is ¥2000. We hand it `amountMinor` straight from the order,
 * so the charge is correct only if our minor-unit convention agrees with
 * Stripe's. If it does not, the customer is charged 100× or 1/100× what they
 * agreed to, and nothing else in the system would notice.
 *
 * So this file is a **second, independent source** for a fact the `currencies`
 * table in pricing-service also holds. `assertExponentMatchesStripe` compares
 * them before an intent is created. Two sources that must agree is the same
 * belt-and-braces M9 used for idempotency and M10 for shipment creation — and
 * it is worth more here than anywhere, because this is the only operation in
 * the project that moves real money.
 *
 * The lists come from Stripe's documented currency support. They change when
 * Stripe says so, not when this shop adds a currency — which is precisely why
 * they live here rather than being read from pricing.
 *
 * @see https://docs.stripe.com/currencies#zero-decimal
 */

/** Currencies Stripe treats as having no minor unit at all. */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/**
 * Currencies Stripe accepts in thousandths, but **must be rounded to the
 * nearest hundred** — Stripe's "three-decimal" list.
 *
 * Present for completeness and to refuse them loudly: this project does not do
 * the rounding those currencies require, so accepting one would produce an
 * amount Stripe rejects, or worse, silently truncates. None are seeded.
 */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Stripe's minor-unit exponent for a currency, or null if we cannot say. */
export function stripeExponentFor(currency: string): number | null {
  const code = currency.toUpperCase();

  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;

  // Everything else Stripe supports is two. Returning 2 for an unrecognised
  // code would be a guess; the caller decides what to do with null.
  return /^[A-Z]{3}$/.test(code) ? 2 : null;
}

export function isThreeDecimal(currency: string): boolean {
  return THREE_DECIMAL.has(currency.toUpperCase());
}
