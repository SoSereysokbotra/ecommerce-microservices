/**
 * Integer money arithmetic.
 *
 * Every amount in this service is an integer number of minor units — 1999 is
 * $19.99 — and every rate is an integer number of basis points — 725 is 7.25%.
 * There is deliberately no floating point value anywhere in the pricing path,
 * not even briefly, because binary floating point cannot represent most decimal
 * fractions exactly and money that is off by a cent is money that is wrong.
 *
 * Only two operations here can lose information, and they are the only two
 * places in the whole quote pipeline where rounding happens at all:
 * `divRound`, and the leftover pennies in `allocate`.
 *
 * See docs/M8_PRICING_PLAN.md §9.
 */

/** Largest product these helpers will accept before precision is at risk. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Half-up division of two integers.
 *
 *   divRound(9042 * 725, 10000)  ->  656      (655.545 rounds up)
 *
 * Half-up is the commercial convention and the one a customer checking the
 * arithmetic by hand will use. Banker's rounding is defensible for statistics
 * and surprising on a receipt.
 *
 * Both arguments are non-negative integers — this service never computes a
 * negative amount, and accepting one silently would hide the bug that produced
 * it. `Math.floor((n + d/2) / d)` is only "half-up" for non-negative input;
 * for negatives it rounds towards positive infinity, which is a different rule.
 */
export function divRound(numerator: number, denominator: number): number {
  assertNonNegativeInteger(numerator, 'numerator');

  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new Error(`denominator must be a positive integer, got ${denominator}`);
  }
  if (numerator > MAX_SAFE - denominator) {
    throw new Error(`divRound would lose precision: ${numerator} / ${denominator}`);
  }

  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/**
 * Multiply an amount by a basis-point rate, rounded half-up.
 *
 *   applyRate(9042, 725)  ->  656      7.25% of 9042
 *
 * Separate from `divRound` only to give the overflow guard something meaningful
 * to check: an amount large enough to overflow when multiplied by 10000 is a
 * bug upstream, not a rounding question.
 */
export function applyRate(amountMinor: number, rateBp: number, divisorBp = 10000): number {
  assertNonNegativeInteger(amountMinor, 'amountMinor');
  assertNonNegativeInteger(rateBp, 'rateBp');

  if (amountMinor !== 0 && rateBp !== 0 && amountMinor > MAX_SAFE / rateBp) {
    throw new Error(`applyRate would overflow: ${amountMinor} * ${rateBp}`);
  }

  return divRound(amountMinor * rateBp, divisorBp);
}

/**
 * Split `total` across `weights` so that the parts sum to **exactly** `total`.
 *
 *   allocate(1005, [5997, 1250, 2800])  ->  [600, 125, 280]
 *
 * The largest-remainder method: give every entry its exact share floored to a
 * whole minor unit, then hand the leftover pennies out one at a time, starting
 * with whichever entry lost the most to the flooring. Ties go to the lower
 * index, so the result is deterministic rather than merely correct in total.
 *
 * This exists because rounding each share independently either loses or invents
 * cents. Two things in a quote need splitting this way:
 *
 *   1. An order-level discount pushed down onto the lines, because a line is
 *      taxed on what that line actually cost after the discount.
 *   2. A tax group's single rounded tax figure pushed down onto its lines,
 *      because orders stores tax per line. Note the direction: the group is
 *      rounded once and then divided up, never the other way round — see
 *      docs/M8_PRICING_PLAN.md §3 for what happens if you round per line.
 *
 * Weights are the amounts being split against, so `total <= sum(weights)` is
 * expected; with that held, no part can exceed its own weight.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  assertNonNegativeInteger(total, 'total');
  weights.forEach((w, i) => assertNonNegativeInteger(w, `weights[${i}]`));

  const sum = weights.reduce((a, b) => a + b, 0);

  // Nothing to split against. Returning zeros rather than throwing keeps the
  // caller simple: an all-zero basket is a legitimate thing to quote.
  if (sum === 0 || total === 0) {
    return weights.map(() => 0);
  }
  if (total > sum) {
    throw new Error(`cannot allocate ${total} across weights summing to ${sum}`);
  }
  if (total > MAX_SAFE / Math.max(...weights)) {
    throw new Error(`allocate would overflow: ${total} * ${Math.max(...weights)}`);
  }

  // Exact share as a fraction, kept as (quotient, remainder) so no float is
  // ever constructed. remainder/sum is precisely the part that was floored away.
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const remainders = weights.map((w) => (total * w) % sum);

  let leftover = total - parts.reduce((a, b) => a + b, 0);

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; leftover > 0; i++, leftover--) {
    parts[order[i].index] += 1;
  }

  return parts;
}
