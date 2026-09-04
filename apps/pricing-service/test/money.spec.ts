import { allocate, applyRate, divRound } from '../src/modules/pricing/money';

describe('divRound', () => {
  it('rounds half up', () => {
    expect(divRound(5, 2)).toBe(3); // 2.5
    expect(divRound(7, 2)).toBe(4); // 3.5
    expect(divRound(4, 2)).toBe(2); // exact
    expect(divRound(1, 3)).toBe(0); // 0.33
    expect(divRound(2, 3)).toBe(1); // 0.67
  });

  it('rounds the worked example from the plan', () => {
    // 7.25% of 9042 is 655.545
    expect(divRound(9042 * 725, 10000)).toBe(656);
  });

  it('refuses a negative numerator rather than applying a different rule to it', () => {
    // Math.floor((n + d/2) / d) rounds towards +infinity for negatives, which is
    // not half-up. This service never computes a negative amount, so the input
    // is a bug worth surfacing.
    expect(() => divRound(-5, 2)).toThrow(/non-negative integer/);
  });

  it('refuses a non-integer or non-positive denominator', () => {
    expect(() => divRound(10, 0)).toThrow(/positive integer/);
    expect(() => divRound(10, 2.5)).toThrow(/positive integer/);
  });
});

describe('applyRate', () => {
  it('applies a basis-point rate', () => {
    expect(applyRate(9042, 725)).toBe(656); // 7.25% exclusive
    expect(applyRate(3645, 600)).toBe(219); // 6%
    expect(applyRate(5397, 0)).toBe(0); // exempt
  });

  it('backs tax out of a gross amount with the inclusive divisor', () => {
    // 19% already inside 9042: 9042 * 1900 / 11900
    expect(applyRate(9042, 1900, 10000 + 1900)).toBe(1444);
  });

  it('is exact for a zero amount', () => {
    expect(applyRate(0, 1900)).toBe(0);
  });
});

describe('allocate', () => {
  it('splits the plan worked example so the parts sum to the whole', () => {
    const parts = allocate(1005, [5997, 1250, 2800]);
    expect(parts).toEqual([600, 125, 280]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1005);
  });

  it('gives leftover pennies to the largest discarded fraction first', () => {
    // 10 across three equal weights: 3.33 each, one penny left over, and the
    // tie breaks on index so the result is deterministic.
    expect(allocate(10, [100, 100, 100])).toEqual([4, 3, 3]);
  });

  it('never gives a part more than its own weight', () => {
    expect(allocate(5, [1, 1, 100])).toEqual([0, 0, 5]);
    expect(allocate(102, [1, 1, 100])).toEqual([1, 1, 100]);
  });

  it('ignores zero weights', () => {
    expect(allocate(50, [0, 100, 0])).toEqual([0, 50, 0]);
  });

  it('returns zeros when there is nothing to split or nothing to split against', () => {
    expect(allocate(0, [10, 20])).toEqual([0, 0]);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
  });

  it('refuses to allocate more than the weights can absorb', () => {
    expect(() => allocate(101, [50, 50])).toThrow(/cannot allocate/);
  });

  it('sums to the total for many awkward splits', () => {
    for (let total = 0; total <= 200; total++) {
      for (const weights of [
        [1, 1, 1],
        [333, 333, 334],
        [1, 2, 3, 5, 8, 13],
        [1000, 1, 1],
      ]) {
        const sum = weights.reduce((a, b) => a + b, 0);
        if (total > sum) continue;
        expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});
