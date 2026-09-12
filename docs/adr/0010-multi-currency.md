# ADR-0010 — Convert prices not totals, and stop assuming a minor unit is a hundredth

**Date:** 2026-09-12
**Status:** Accepted
**Milestone:** M11

## Context

Every amount in this project has been an integer number of minor units since
M0, and that discipline held: no float ever touched the pricing path. But
"minor units" quietly meant *hundredths* everywhere, and nothing said so.
`formatMoney` divided by 100. Nobody wrote `× 100` as a conversion; they wrote
it as a fact.

It is false for Japanese yen, which has no minor unit at all. A codebase that
divides by 100 shows ¥10.00 for a ¥1000 item and charges a customer one
hundredth of what they owe — while every existing test still passes, because
every existing test is in dollars.

An audit found **17 money columns across six services**, of which four carry a
currency. Three of the rest — `discounts.value_minor`,
`discounts.min_subtotal_minor`, `shipping_rates.free_over_minor` — are
thresholds with no currency anywhere near them, all in pricing-service. Not a
coincidence: they were written when there was one currency.

---

## Decision 1 — Convert the unit price, not the total

The obvious implementation: compute the quote in USD as today, multiply
`totalMinor` by the rate at the end. One conversion, one rounding.

**Rejected.** A quote does not return only a total. It returns per-line
subtotals, discounts and tax, a tax breakdown per rate group, a shipping figure
— and orders freezes all of them onto `order_items`. Converting only the total
leaves every one of those in dollars against a euro total, so either they get
converted individually (the per-line rounding ADR-0007 spent a milestone
removing) or allocated down from the converted total (a second allocation layer
on the one that already exists).

**Chosen: convert the unit price, then run the existing pipeline unchanged in
the target currency.**

```
catalog price  1999 USD
      ↓ × rate, rounded ONCE           ← the only FX rounding
display price  1849 EUR
      ↓
computeQuote(currency: 'EUR')          ← untouched
```

Converting a unit price is the same act as a price-book entry, which is where
FX rounding belongs: once, per product, on a number a customer actually sees.
Line arithmetic stays exact — `unitPrice × qty` still holds on the page. And
**`quote.ts` needed no change at all**, which is the strongest evidence this
was the right seam.

The cost: a euro total is not exactly the dollar total times the rate. It is
the total of converted prices, and the difference of a few cents is real rather
than an error — the same reason a shop's euro prices are not its dollar prices
converted.

### Shipping is asked in the base currency

The free-shipping threshold is denominated in the rate's own currency. Rather
than convert the basket to test a threshold, pricing asks shipping in the base
currency — comparing like with like — and converts only the resulting cost.

### Thresholds convert with the same rate

"Spend $50, save $5" becomes "spend €46.30, save €4.63", which no marketing
department would write. The alternative is a per-currency row for every
promotion — correct, and a bigger milestone. Recorded as the first thing a real
shop would fix.

---

## Decision 2 — The exponent is data, and the conversion is BigInt

A `currencies` table holds `exponent` per code — 2 for USD and EUR, **0 for
JPY** — constrained to `0..4` at the column, because a wrong value here
misprices by a factor of a hundred. `formatMoney` takes the exponent from the
quote or the order instead of assuming it.

Conversion between exponents is:

```
amountTo = amountFrom × rate × 10^(expTo − expFrom)
1999 × 150 × 10^(0−2) = 2998.5 → ¥2999
```

Not ¥299,850 (dropping the exponent) and not ¥29 (treating yen as cents). Both
wrong answers are off by a hundred and both look plausible.

**Done in `BigInt`**, because the numerator — amount × rate × 10^exponent —
passes `MAX_SAFE_INTEGER` for a large basket at 1e8 rate scale. `money.ts` bans
floats, not large integers. The alternative, a smaller rate scale with a
documented range, was rejected: a money function with a range nobody will
remember is a bug with a delay on it.

A round trip is asserted **not** to be the identity — $19.99 → 20 units of a
zero-decimal currency → $20.00 — so nobody "fixes" it later by rounding
differently, which would only move the loss.

---

## Decision 3 — The rate log is append-only, and no rate is ever inverted

`fx_rates` has **no unique constraint on the pair**. A refresh inserts; the
newest wins. "What was the rate on Tuesday" stays answerable, and a refresh
cannot rewrite a figure a quote already used. An order is protected anyway — it
freezes the rate — but a table that updated in place would make the order the
only record, and a bug in the freezing would then be invisible.

`FxService` **does not invert**. Asked for JPY→USD with only USD→JPY present,
it fails. Real buy and sell rates are not reciprocals, and a shop that silently
sells at its buy rate loses the spread on every transaction. A reverse pair is a
row, not a division. The migration forbids a same-currency row for the mirror
reason: `convert()` short-circuits parity, and a USD→USD row would be a second
path to parity that could disagree.

**A stale rate prices a basket slightly wrong; no rate prices nothing.** So a
failed refresh logs and leaves the last rate; age is warned about, not
enforced. The refresh job ships with `FX_PROVIDER_URL` unset — this project has
no FX key, and the content is the pattern, not the HTTP call.

---

## Decision 4 — Payments compares our minor unit against Stripe's before charging

Stripe is handed `amount_minor` directly, so a charge is correct only if our
exponent agrees with Stripe's. A disagreement is a 100× charge on a real card,
and nothing downstream would notice: the amount is a valid integer and Stripe
accepts it.

So `orders.exponent` is frozen at purchase and travels on `payment.requested`;
payments holds **Stripe's own zero-decimal list** as an independent second
source and refuses when the two disagree, when it has no convention for the
currency at all, or when the currency is one of Stripe's three-decimal set
(which needs rounding this project does not do). Two sources that must agree is
the belt-and-braces M9 and M10 used for idempotency, applied to the one
operation that moves money.

Verified end to end: a JPY order reached Stripe, and Stripe's API reported
`amount=3815 currency=jpy` — whole yen.

---

## Smaller decisions

- **`orders.exponent` earns its place twice.** The payments check above, and
  letting the order page format a historical order without re-reading a table
  that can change. Null means "placed before M11", a different fact from
  "exponent 2" — the distinction M8 and M10 both drew, which is what let the
  M10 audit account for every row.
- **The order page ignores the header's currency switcher.** An order is a
  record of what was agreed; a yen order must not grow two decimal places
  because the shopper switched to dollars. Verified by switching after placing.
- **The switcher reloads the page.** The honest way to make every price
  re-quote; the alternative is a context every money-rendering component
  subscribes to, which M11 does not need.
- **Product pages stay in the base currency.** Converting a listing needs a
  quote per product or client-side arithmetic; the second is the two-totals
  defect M8 removed, wearing a different hat. The cart is where the number
  becomes binding, and the cart converts.
- **Only forward pairs are seeded** (USD→EUR, USD→JPY), following Decision 3.

---

## What this costs, and what is not covered

- **Thresholds in odd amounts** — "€46.30". See Decision 1.
- **No live FX provider.** Seeded rates stand; the job is verified against a
  stub, including provider-down and implausible-rate paths.
- **Three-decimal currencies are refused**, not supported.
- **Product listings do not convert.** A JPY shopper sees dollar prices until
  the cart.
- **Orders placed before M11 carry null exponent and rate**, read as
  "hundredths, no conversion". Every one of them was in dollars, so that is
  true, but it is an assumption for those rows rather than a fact.

---

## Evidence

### Three currencies, hand-computed before being run

One tee to US-CA:

| | rate | unit | shipping | tax | total |
|---|---:|---:|---:|---:|---:|
| USD | 1 | 1999 | 399 | 145 | **2543** |
| EUR | 0.925 | 1849 | 369 | 134 | **2352** |
| JPY | 150, exp 0 | 2999 | 599 | 217 | **3815** |

Every figure matched on the first run. The JPY unit price is 2999, not 299850
and not 29.

### The historical order does not move

```
order placed          JPY  rate=150  TOTAL=3815
rate moves 150 -> 200 (new append-only row)
new quote             rate=200  TOTAL=5086
the existing order    rate=150  TOTAL=3815   <- unchanged
```

### Mutation testing on `convert()`

| Mutation | Tests failed |
|---|---|
| exponent delta reversed | 7 |
| exponent term dropped | 7 |
| half-up becomes truncate | 5 |
| parity shortcut ignores exponent | 2 |

### The refresh job, against a stub provider

Two rates recorded, three skipped (unknown currency, parity, unoffered);
provider down → "keeping the last known rates", quotes unaffected; negative
and zero rates filtered before insert.

### In the browser

One basket, three currencies, three different totals, each matching its quote;
the yen total rendered as `¥3,815` with no decimal point; a yen order still
shown in yen after switching the header to dollars.

---

## Related

- **ADR-0007** — round once per tax group. Decision 1 exists to leave it intact.
- **ADR-0009** — the frozen-figure pattern (tax, then shipping) that Decision 3
  applies a third time to the rate.
- `docs/M11_CURRENCY_PLAN.md` — the audit and the argument, before any code.
