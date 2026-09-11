import { isThreeDecimal, stripeExponentFor } from '../src/modules/payments/stripe-currencies';

/**
 * Stripe's minor-unit convention, which is the second of two independent
 * sources for a fact pricing's `currencies` table also holds.
 *
 * The reason this file exists: Stripe is handed `amountMinor` directly, so a
 * disagreement between the two is a 100× charge on a real card, and nothing
 * else in the system would notice — the amount is a valid integer and Stripe
 * accepts it.
 */
describe('stripeExponentFor', () => {
  it('knows yen has no minor unit', () => {
    // The case M11 exists for. 2000 is ¥2000, not ¥20.00.
    expect(stripeExponentFor('JPY')).toBe(0);
    expect(stripeExponentFor('jpy')).toBe(0);
  });

  it('knows the other zero-decimal currencies Stripe lists', () => {
    for (const code of ['KRW', 'VND', 'CLP', 'XAF', 'XOF']) {
      expect(stripeExponentFor(code)).toBe(0);
    }
  });

  it('treats the ordinary currencies as hundredths', () => {
    expect(stripeExponentFor('USD')).toBe(2);
    expect(stripeExponentFor('EUR')).toBe(2);
    expect(stripeExponentFor('GBP')).toBe(2);
  });

  it('reports three-decimal currencies as three, not as two', () => {
    // Returning 2 here would be the quiet wrong answer: the amount would be a
    // thousandth of what was meant.
    expect(stripeExponentFor('KWD')).toBe(3);
    expect(isThreeDecimal('BHD')).toBe(true);
  });

  it('returns null for something that is not a currency code', () => {
    // Not 2. A guess here is the assumption this milestone exists to remove.
    expect(stripeExponentFor('DOLLARS')).toBeNull();
    expect(stripeExponentFor('')).toBeNull();
    expect(stripeExponentFor('U$D')).toBeNull();
  });

  it('does not claim three-decimal for an ordinary currency', () => {
    expect(isThreeDecimal('USD')).toBe(false);
    expect(isThreeDecimal('JPY')).toBe(false);
  });
});
