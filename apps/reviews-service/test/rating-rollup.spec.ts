import { ratingAvgE2 } from '../src/modules/reviews/rating-rollup';

/**
 * Pure integer arithmetic for rating rollups.
 *
 * Requirements from docs/M13_REVIEWS_PLAN.md §4:
 *   - Pure function ratingAvgE2(sum, count) -> integer hundredth (437 = 4.37).
 *   - Round-half-up, computed in BigInt.
 *   - Returns 0 when count is 0 or sum is 0.
 *   - No floats anywhere.
 */
describe('ratingAvgE2', () => {
  it('returns 0 when count is 0', () => {
    expect(ratingAvgE2(0, 0)).toBe(0);
    expect(ratingAvgE2(10, 0)).toBe(0);
    expect(ratingAvgE2(-5, 0)).toBe(0);
  });

  it('returns 0 when sum is non-positive', () => {
    expect(ratingAvgE2(0, 5)).toBe(0);
    expect(ratingAvgE2(-10, 5)).toBe(0);
  });

  it('computes exact divisions with trailing zeros: (9, 2) -> 450 and (7, 2) -> 350', () => {
    // 9 / 2 = 4.5 -> 450
    expect(ratingAvgE2(9, 2)).toBe(450);
    // 7 / 2 = 3.5 -> 350
    expect(ratingAvgE2(7, 2)).toBe(350);
  });

  it('rounds half up: (13, 3) rounds down to 433 and (14, 3) rounds up to 467', () => {
    // 13 / 3 = 4.3333... -> 433.333... rounds down to 433
    expect(ratingAvgE2(13, 3)).toBe(433);
    // 14 / 3 = 4.6666... -> 466.666... rounds up to 467
    expect(ratingAvgE2(14, 3)).toBe(467);
  });

  it('rounds exactly half upwards', () => {
    // 1 / 200 = 0.005 -> 0.50 hundredths -> rounds up to 1
    expect(ratingAvgE2(1, 200)).toBe(1);
    // 3 / 200 = 0.015 -> 1.50 hundredths -> rounds up to 2
    expect(ratingAvgE2(3, 200)).toBe(2);
  });

  it('computes integer averages correctly for single and multiple reviews', () => {
    expect(ratingAvgE2(5, 1)).toBe(500);
    expect(ratingAvgE2(4, 1)).toBe(400);
    expect(ratingAvgE2(1, 1)).toBe(100);
    expect(ratingAvgE2(15, 3)).toBe(500);
    // 8 / 3 = 2.6666... -> 267
    expect(ratingAvgE2(8, 3)).toBe(267);
  });

  it('handles large numbers past Number.MAX_SAFE_INTEGER / 100 without precision loss', () => {
    // Number.MAX_SAFE_INTEGER is ~9e15. Sum * 100 would exceed MAX_SAFE_INTEGER if sum > 9e13.
    // In BigInt, 900_000_000_000_000 * 100 = 9e16, which BigInt calculates exactly.
    const largeSum = 900_000_000_000_000;
    const largeCount = 200_000_000_000_000;
    expect(ratingAvgE2(largeSum, largeCount)).toBe(450);
  });
});
