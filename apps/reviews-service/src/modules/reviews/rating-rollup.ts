/**
 * Derives the star rating average for the search projection.
 *
 * ## Why an integer hundredth (ADR-0010, M13_REVIEWS_PLAN.md §4)
 *
 * A star rating average is money-shaped: a number people compare, that gets
 * sorted on, and that must never drift. ADR-0010's rule — no floats anywhere
 * on the path — is not about currency specifically; it is about numbers that
 * cannot tolerate IEEE 754 precision drift.
 *
 * `product_ratings` stores the raw truth: `rating_sum` and `rating_count`.
 * This function computes `ratingAvgE2` at emit time in BigInt and carries it
 * as an integer (437 = 4.37). OpenSearch sorts on the integer; the storefront
 * divides by 100 only at the final presentation layer. Nothing ever stores
 * `4.37`.
 *
 * ## Round-half-up in BigInt
 *
 * In pure integer arithmetic, round_half_up(A / B) for non-negative A and
 * positive B is:
 *
 *   let Q = A / B, R = A % B
 *   return (2 * R >= B) ? Q + 1 : Q
 *
 * Here A = sum * 100, B = count.
 *
 * Worked examples:
 *   - (0, 0)   -> 0 (returns 0 when count is 0)
 *   - (9, 2)   -> 900 / 2 = 450 R 0   -> 450 (4.50)
 *   - (13, 3)  -> 1300 / 3 = 433 R 1  -> 2*1 < 3  -> 433 (4.333... rounds down)
 *   - (14, 3)  -> 1400 / 3 = 466 R 2  -> 2*2 >= 3 -> 467 (4.666... rounds up)
 *   - (7, 2)   -> 700 / 2 = 350 R 0   -> 350 (3.50)
 */
export function ratingAvgE2(sum: number, count: number): number {
  if (count <= 0 || sum <= 0) {
    return 0;
  }

  const s = BigInt(Math.floor(sum));
  const c = BigInt(Math.floor(count));

  if (c <= 0n || s <= 0n) {
    return 0;
  }

  const a = s * 100n;
  const q = a / c;
  const r = a % c;

  const rounded = 2n * r >= c ? q + 1n : q;
  return Number(rounded);
}
