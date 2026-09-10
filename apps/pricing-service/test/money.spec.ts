import { allocate, applyRate, convert, divRound } from '../src/modules/pricing/money';

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

// ---------------------------------------------------------------------------
// M11 — converting between currencies
//
// Every figure below was computed by hand before it was run, the method M8 and
// M10 used. Exponents are the point: USD and EUR have two decimal places, JPY
// has none, and the arithmetic has to know.
// ---------------------------------------------------------------------------

/** USD → JPY at 150.0, held at 1e8 scale. */
const USD_JPY = 15_000_000_000;
/** JPY → USD at 0.00666667 — near enough the inverse of 150. */
const JPY_USD = 666_667;
/** USD → EUR at 0.925. */
const USD_EUR = 92_500_000;
/** Parity. */
const ONE = 100_000_000;

describe('convert', () => {
  describe('to a currency with FEWER decimal places (USD -> JPY)', () => {
    it('applies the exponent difference, not just the rate', () => {
      // 1999 × 150 × 10^(0−2) = 2998.5 → half-up → 2999
      // NOT 299_850 (dropping the exponent term) and NOT 29 (treating yen as
      // having cents). Both are wrong by a factor of a hundred and both look
      // perfectly plausible on a page.
      expect(convert(1999, { rateE8: USD_JPY, fromExponent: 2, toExponent: 0 })).toBe(2999);
    });

    it('is exact when the arithmetic divides evenly', () => {
      // 1000 × 150 / 100 = 1500
      expect(convert(1000, { rateE8: USD_JPY, fromExponent: 2, toExponent: 0 })).toBe(1500);
    });

    it('rounds half-up, like every other rounding in this file', () => {
      // 1 cent × 150 / 100 = 1.5 → 2 yen
      expect(convert(1, { rateE8: USD_JPY, fromExponent: 2, toExponent: 0 })).toBe(2);
    });
  });

  describe('to a currency with MORE decimal places (JPY -> USD)', () => {
    it('gains the decimals back', () => {
      // 3000 × 0.00666667 × 10^(2−0) = 2000.001 → 2000  ($20.00)
      expect(convert(3000, { rateE8: JPY_USD, fromExponent: 0, toExponent: 2 })).toBe(2000);
    });
  });

  describe('between currencies with the same exponent (USD -> EUR)', () => {
    it('is just the rate', () => {
      // 1999 × 0.925 = 1849.075 → 1849
      expect(convert(1999, { rateE8: USD_EUR, fromExponent: 2, toExponent: 2 })).toBe(1849);
    });

    it('rounds a quarter down', () => {
      // 1250 × 0.925 = 1156.25 → 1156. Half-up rounds .5 up; .25 is not .5.
      expect(convert(1250, { rateE8: USD_EUR, fromExponent: 2, toExponent: 2 })).toBe(1156);
    });
  });

  describe('parity', () => {
    it('returns the input exactly, with nothing applied', () => {
      expect(convert(1999, { rateE8: ONE, fromExponent: 2, toExponent: 2 })).toBe(1999);
      expect(convert(0, { rateE8: ONE, fromExponent: 2, toExponent: 2 })).toBe(0);
    });

    it('still does the work when only the exponent differs', () => {
      // Same "rate", different currencies: 1999 × 1 × 10^(0−2) = 19.99 → 20.
      expect(convert(1999, { rateE8: ONE, fromExponent: 2, toExponent: 0 })).toBe(20);
    });
  });

  describe('a round trip is NOT the identity, and that is not a bug', () => {
    it('loses the sub-unit when the target currency has none', () => {
      // $19.99 → 20 units of a zero-decimal currency → $20.00.
      // The cent had nowhere to go. Asserting this stops someone "fixing" it
      // later by rounding differently, which would only move the loss.
      const there = convert(1999, { rateE8: ONE, fromExponent: 2, toExponent: 0 });
      const back = convert(there, { rateE8: ONE, fromExponent: 0, toExponent: 2 });

      expect(there).toBe(20);
      expect(back).toBe(2000);
      expect(back).not.toBe(1999);
    });

    it('does not come back through a buy and a sell rate', () => {
      // Real rates are not exact inverses — 0.925 out, 1.08 back.
      // 1999 → 1849 → 1849 × 1.08 = 1996.92 → 1997.
      const there = convert(1999, { rateE8: USD_EUR, fromExponent: 2, toExponent: 2 });
      const back = convert(there, { rateE8: 108_000_000, fromExponent: 2, toExponent: 2 });

      expect(there).toBe(1849);
      expect(back).toBe(1997);
    });
  });

  describe('the reason this uses BigInt', () => {
    it('handles an amount that would overflow plain Number arithmetic', () => {
      // $100,000 × 150 = ¥15,000,000.
      // The numerator here is 10^7 × 1.5e10 = 1.5e17, comfortably past
      // MAX_SAFE_INTEGER (9.007e15). `divRound` would refuse this; BigInt is
      // exact, so the answer is right rather than absent.
      expect(convert(10_000_000, { rateE8: USD_JPY, fromExponent: 2, toExponent: 0 })).toBe(
        15_000_000,
      );
    });

    it('refuses a result too large to hand back as a Number', () => {
      // The BigInt maths stays exact; returning it as a double would not.
      // Better to refuse than to return a plausible wrong figure.
      expect(() =>
        convert(Number.MAX_SAFE_INTEGER - 1, {
          rateE8: USD_JPY,
          fromExponent: 0,
          toExponent: 0,
        }),
      ).toThrow(/MAX_SAFE_INTEGER/);
    });
  });

  describe('refuses input it cannot be right about', () => {
    it('rejects a negative amount', () => {
      expect(() => convert(-1, { rateE8: ONE, fromExponent: 2, toExponent: 2 })).toThrow(
        /non-negative integer/,
      );
    });

    it('rejects a non-integer amount', () => {
      expect(() => convert(19.99, { rateE8: ONE, fromExponent: 2, toExponent: 2 })).toThrow(
        /non-negative integer/,
      );
    });

    it('rejects a zero or negative rate', () => {
      expect(() => convert(1999, { rateE8: 0, fromExponent: 2, toExponent: 2 })).toThrow(
        /positive integer/,
      );
      expect(() => convert(1999, { rateE8: -1, fromExponent: 2, toExponent: 2 })).toThrow(
        /positive integer/,
      );
    });

    it('rejects a negative exponent', () => {
      expect(() => convert(1999, { rateE8: ONE, fromExponent: -1, toExponent: 2 })).toThrow(
        /non-negative integer/,
      );
    });
  });

  it('converts zero to zero in every direction', () => {
    expect(convert(0, { rateE8: USD_JPY, fromExponent: 2, toExponent: 0 })).toBe(0);
    expect(convert(0, { rateE8: JPY_USD, fromExponent: 0, toExponent: 2 })).toBe(0);
  });
});
