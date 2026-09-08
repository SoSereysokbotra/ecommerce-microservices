# ADR-0007 — Round once per tax group, and give pricing sole ownership of money

**Date:** 2026-09-04
**Status:** Accepted
**Milestone:** M8

## Context

Until M8 a basket cost the sum of its catalog prices, computed in one line
inside `OrdersService.create()` and, separately, in the storefront's cart page.
M8 adds tax and discounts, which turns that line into an arithmetic problem with
two decisions in it that are easy to get wrong and hard to notice.

Money arithmetic fails differently from everything else in this project. The
saga is about failures you can see — a service is down, a card is declined. A
total that is one cent wrong looks exactly like a total that is right.

Two decisions needed recording. Both depart from what
`docs/IMPLEMENTATION_PLAN.md` said, and both were argued in
`docs/M8_PRICING_PLAN.md` (§3 and §4) before any code was written.

---

## Decision 1 — Tax is rounded once per **tax rate group**, never per line

The plan's guidance for M8 read:

> *Watch for:* rounding. Round once, at the end. Test totals across three regions.

The instinct is right and the phrasing is wrong. You cannot round once for a
basket, because different lines in one basket can carry different rates — that
is the entire point of keying `tax_rates` by category. There is no single "the
end" to round at.

**The rule implemented is:** group the lines by the rate that applies to them,
sum each group's taxable base exactly, and round that group's tax exactly once.
A basket with three rates rounds three times, and no more.

### Why it matters

This is not theoretical. Rounding each line separately and summing diverges from
rounding the group, using this project's own seeded prices, at 7.25%:

```
unit  qty   per-line sum   per-group   diff
 600   x6        264          261       +3
1250   x6        546          544       +2
1400   x6        612          609       +3
2250   x6        978          979       -1
```

Six sticker packs are three cents apart depending on where you round, and the
error does not even have a consistent sign — at 2250 the per-line total comes out
*lower*. Both figures are "the tax", both computed with correct arithmetic, and
only one is what the customer owes.

### The corollary: allocation, not re-rounding

Two things still need per-line figures — `order_items.tax_minor`, and a
discount that must be applied before tax because a line is taxed on what that
line actually cost. Both are produced by **allocating** a single rounded total
across the lines using the largest-remainder method, so the parts always sum
back to the whole. Neither is an independently rounded number.

`allocate()` therefore appears twice in the pipeline for the same underlying
reason, which is a fair sign the abstraction is the right one. Rounding happens
in exactly two places — the discount allocation and the per-group tax — and
nowhere else. Everything before them is exact integer arithmetic.

### Supporting choices

- **Integer basis points on disk** (`725` = 7.25%). A `numeric` column invites a
  float in the code that reads it; stored this way there is no floating point
  value anywhere in the pricing path, not even briefly.
- **Half-up rounding.** The commercial convention, and the one a customer
  checking the arithmetic by hand will use. Banker's rounding is defensible for
  statistics and surprising on a receipt.
- **Inclusive versus exclusive tax is a property of the rate**, not of the
  system. US sales tax is added to the shelf price; EU VAT is already inside it.
  `prices_include_tax` selects `round(base × rate / 10000)` or
  `round(base × rate / (10000 + rate))`. Handling only the exclusive case would
  have made "three tax regions" mean "three different percentages", which is not
  much of a test.

---

## Decision 2 — `pricing-service` owns the whole quote; orders stops pricing

The plan said "a single `POST /pricing/quote` that orders calls to price a
basket", leaving open what orders sends. Two shapes were possible:

**(a)** Orders keeps its catalog lookup and sends *priced* lines; pricing only
applies tax and discounts.
**(b)** Callers send `productId` and `qty` only; pricing reads catalog itself
and returns the fully priced basket.

**(b) was chosen.** `OrdersService.priceItems()` and its catalog loop are
deleted, and orders no longer calls catalog at all.

### Rationale

Under (a) two places compute what a basket costs — the storefront's cart page,
which summed catalog prices in the browser, and orders-service. They can
disagree, and the way you find out is a customer seeing one number and being
charged another. Under (b) there is exactly one implementation, and both the
cart page and orders get their answer from it. That is the whole reason to make
pricing a service rather than a library.

It also fits what M7 decided: the cart deliberately stores **no prices**, so the
storefront had no priced lines to send even if we had wanted shape (a).

### What this costs

- **One more hop in the critical path.** Order creation used to fail if catalog
  was unreachable; now it fails if pricing *or* catalog is unreachable. This is
  accepted because it is the same *kind* of dependency the project already
  documented — a read before anything commits, so a failure rejects the request
  cleanly with nothing half-done. It adds one more thing that can be down, not a
  new failure mode.
- **`POST /orders` had to change**, for the first time since M5. M7 went out of
  its way not to touch the saga's entry point; M8 could not, because the amount
  charged comes from `order.totalMinor`. The change is confined to `create()`
  and the new columns — no saga step, no event sequence, no compensation path.

### The quote is frozen onto the order

`order_items` already copied sku, name and price at purchase time, because an
order is a record of what was bought at a price the customer agreed to. Tax and
discount are the same kind of fact and get the same treatment. Change a rate
tomorrow and every historical order is unaffected, because nothing re-reads
`tax_rates` to display one. This is the same principle M11 will apply to FX
rates.

`order.created` deliberately kept its existing payload. Its consumer is
inventory, which cares about product ids and quantities; adding money to it
would be payload for an imagined future.

---

## Two smaller decisions recorded here

**`pricing-service` has no outbox, no consumers and no `processed_events`** —
the first service in the project with none. A quote is a pure read that changes
no state, so there is nothing to make atomic with an event and nothing to
deduplicate on redelivery. Five of the six services before it have that wiring
and pasting it in out of habit would have added a queue nobody publishes to.
**M9 will add it**, because a coupon redemption *is* state and must be released
when a saga compensates.

**The destination travels on the request.** Tax is a function of destination and
nothing in this system knows a customer's address until M10. `POST /pricing/quote`
and `POST /orders` both take an optional `destination`, falling back to a
configured store default. Pricing stays stateless about identity, guests get
correct totals, and when M10 lands the shipping address simply becomes what
populates the field — nothing inside pricing changes.

---

## Evidence

Verified against the live stack and the real Neon databases.

### The calculator

37 unit tests over the pure functions, including the plan's worked example in
all three regions and a property test over 500 randomly generated baskets
asserting that `sum(line discounts) == discount`, `sum(line taxes) == tax`, and
`net + tax == total`.

The tests were **mutation-tested** rather than trusted for passing:

| Mutation | Result |
|---|---|
| Round each line's tax directly instead of allocating the group's | 2 tests fail |
| Drop largest-remainder from `allocate`, round each share | 4 tests fail |

### End to end

One basket — 3 × Black Tee, 1 × Black Mug, 2 × USB-C Cable, subtotal 10047 —
with the two seeded promotions applying, placed as real orders through the
gateway:

| Destination | Tax groups | Order total | Stripe PaymentIntent |
|---|---|---:|---:|
| US-CA, 7.25% exclusive | 7.25% on 9359 → 679 | 10038 | **10038** |
| US-PA, 6% with apparel exempt | 0% on 5693, 6% on 3666 → 220 | 9579 | **9579** |
| DE, 19% inclusive | 19% on 9359 → 1494 | 9359 | **9359** |

Every figure was computed by hand before the code was run, and matched —
including which line the single leftover penny of the $5 promotion lands on.

The quote and the order agree exactly in all three regions, which is Decision 2
demonstrated rather than asserted. `payment.requested` carries the tax-inclusive
total, and payments-service created Stripe test-mode intents for those amounts.

Germany is the row to read twice: its total equals the taxable base, because the
tax was already inside the price. A different total there would mean the
inclusive arithmetic is wrong.

### In a browser

4 Playwright tests, passing: the cart shows the API's quote rather than a
browser-side sum; one basket across three regions gives three totals each
matching the API; inclusive tax is labelled "VAT (…, included)" where exclusive
is "Sales tax (…)"; and the chosen region survives a reload.

### A real card, in all three regions

Driven through `stripe listen` with real test-mode webhooks, so the saga is
advanced by `payment.authorized` rather than by the browser:

| Region | Quoted | Stored on the order | Stripe charged | Outcome |
|---|---:|---:|---:|---|
| US-CA | 10038 | 10038 | **10038** | `confirmed` |
| US-PA | 9579 | 9579 | **9579** | `confirmed` |
| DE | 9359 | 9359 | **9359** | `confirmed` |

Afterwards `reserved_qty` matched the held reservations on every product — no
drift. **95 unit tests and 14 Playwright tests pass**, the latter including both
Stripe payment tests and the declined-card compensation path.

### What this milestone's testing uncovered elsewhere

Three of the three orders above pass today. The first attempt did not, and what
it exposed had nothing to do with pricing — but it is worth recording here,
because M8's end-to-end test is what found it:

- **Inventory lost updates.** `reserve`, `commit` and `release` each did an
  unguarded read-modify-write on the stock row. The expiry sweep and a commit
  touching the same product at once drove `reserved_qty` below the units
  actually held; every later commit *and* release then violated
  `CHK_stock_reserved_non_negative`.
- **The expiry sweep failed atomically.** It wrapped every expired order in one
  transaction, so that single bad row stopped stock returning **for the whole
  service**, every 30 seconds, for hours. ADR-0003 calls reservation expiry "the
  backstop under everything else"; it was down until the row was repaired by
  hand.
- **The saga kept the money.** With the commit wedged, the hold lapsed, and
  `onReservationExpired` cancelled the order and marked the saga COMPENSATED —
  without checking that the card had already been charged. Stock came back; the
  payment did not. The saga reported success for an outcome that had taken a
  customer's money for nothing.

All three are fixed: row locks in a deterministic order, one transaction per
order in the sweep, and an expiry path that refunds when payment has been taken.
None of them were pricing bugs, and none would have been found without charging
a real card.

## Related

- `docs/M8_PRICING_PLAN.md` — the full design, and §3/§4 where both decisions
  were argued before implementation
- ADR-0002, ADR-0003 — why the saga exists and why it is orchestrated; M8
  changes its entry point but none of its steps
- M9 will add coupons, which is where redemption state, optimistic locking and
  the outbox arrive in this service
