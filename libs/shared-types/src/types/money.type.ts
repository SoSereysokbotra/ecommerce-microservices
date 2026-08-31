/**
 * Money is always stored and transported as integer minor units plus an explicit
 * currency. Never use a floating point number for an amount.
 *
 *   $19.99 USD  ->  { amountMinor: 1999, currency: 'USD' }
 */
export interface Money {
  amountMinor: number;
  currency: string;
}

export const zeroMoney = (currency: string): Money => ({ amountMinor: 0, currency });

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}
