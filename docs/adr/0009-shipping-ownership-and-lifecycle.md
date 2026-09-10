# ADR-0009 — Shipping goes through the quote, and a shipment is not a saga step

**Date:** 2026-09-10
**Status:** Accepted
**Milestone:** M10

## Context

M8 was arithmetic, M9 was concurrency. M10 is **modelling something that
outlives the request that created it**.

Everything the project had built reached a terminal state within minutes: an
order confirms or cancels, a reservation commits or expires, a coupon use is
spent or given back. A shipment does not. It is created when an order confirms,
sits in `pending` for a day and `dispatched` for a week, and reaches `delivered`
because a human said so — long after every saga, reservation and payment intent
involved has finished.

M10 also had to finish something M8 started. Since M8 the tax destination has
travelled **on the request** with a store default behind it, because nothing in
the system knew a customer's address. That was labelled a placeholder. This is
where it stops being one.

Four decisions below had defensible alternatives, and two of them contradict
what the planning documents say.

---

## Decision 1 — The address book lives in users-service, not shipping-service

The two planning documents disagree, and both are load-bearing:

- `IMPLEMENTATION_PLAN.md` §3: "shipping-service; **customer addresses**; rate
  calculation by weight/zone"
- `PROJECT_PLAN.md` §5: "users-service | 3001 | Auth, customers, **addresses**,
  wishlists"

**Chosen: users-service.**

An address book is a *profile* concern. It belongs to a customer, it is edited
on an account page, it outlives every order, and the next things that will want
it — order confirmation emails (M15), an admin's customer view (M17) — are not
shipping concerns either.

shipping-service never reads the table. It needs two things and neither is an
address book entry: a **destination** to pick a zone, and a **frozen snapshot**
on the shipment so a parcel's label does not change when the customer edits
their address next year. That is the same shape as `order_items` copying sku and
price, and as M8 freezing tax onto the order.

The cost is one more synchronous read at checkout — orders asks users-service
for the address. That is a read before anything commits, so a failure rejects
the request cleanly with nothing half-done, which is the same justification
`PricingClient` and the original catalog lookup have (HANDOFF §7).

**What this buys beyond tidiness.** When an order names a `shippingAddressId`,
the country and region come from a row the customer owns, read server-side.
Verified: an order sent with that address id *and* a body claiming tax-free `KH`
was taxed at **US-CA**. A client can still choose which of its addresses to use;
it can no longer invent one in a jurisdiction that charges no tax.

---

## Decision 2 — Shipping cost goes *through* the quote, not around it

The obvious implementation: `OrdersService.create()` gets a quote, asks shipping
for a rate, adds the two numbers.

**Rejected.** That re-creates the exact defect M8 existed to remove. Before M8,
orders priced the basket and the cart page priced the basket, and the way you
discover two implementations of a total disagree is a customer seeing one number
and being charged another. If orders sums `quote.totalMinor + rate.costMinor`,
orders can produce a total the cart page cannot, and the storefront must
reproduce the same addition to display it — two implementations again, differing
only in that the new one looks trivial.

**Chosen: pricing-service calls shipping-service and folds the rate into the
quote.** `POST /pricing/quote` stays the single answer to "what does this basket
cost". This is precisely the shape M8 chose when it made pricing read catalog
itself, and ADR-0007's reasoning transfers unchanged.

pricing is also the service already holding what a rate needs: it has just
fetched every product, so it knows the weight; it has just applied the
promotions, so it knows the discounted subtotal a free-shipping threshold is
measured against. Orders knows neither without asking somebody.

### The two-pass consequence

A free-shipping threshold is measured against the **discounted** subtotal, which
does not exist until promotions are applied. So a quote is computed twice: price
the goods, ask shipping, price again with the answer folded in.

There is no fixpoint to worry about — shipping never feeds back into discounts,
because order-level promotions allocate across line subtotals and
`minSubtotalMinor` is checked against the goods subtotal. The first pass's
`discountMinor` is final.

### The cost

A quote now needs catalog **and** shipping to be up. `ShippingClient` therefore
copies `CatalogClient`'s 503-vs-400 distinction: an unreachable shipping service
is `503`, never a `400` telling a customer their valid basket is malformed.
Verified by stopping the container mid-quote.

**Not done:** a degraded "calculated at checkout" fallback for browsing. A
half-priced cart page is a subtler failure than a broken one, and `POST /orders`
must never fall back — an order with a guessed shipping cost charges the wrong
amount.

---

## Decision 3 — Delivery joins the tax group for its own rate

Whether delivery is taxed is genuinely jurisdiction-specific, and not guessable:

| Jurisdiction | Delivery |
|---|---|
| California | **not** taxed when separately stated and shipped by common carrier |
| Pennsylvania | **taxed**, when the goods are taxable |
| Germany | ancillary to the supply: the goods' VAT rate, **inside** the price |

So it is a column — `tax_rates.shipping_taxable` — read only off the **general**
rule for a destination (`category IS NULL`), because delivery has no product
category. Pennsylvania exempts clothing and still taxes the postage on it.

**The decision that had an alternative:** whether delivery forms its **own** tax
group or joins the group for its rate.

**Chosen: it joins.** ADR-0007's rule is "round once per tax rate group", and
that means once per *rate*. A private group for delivery would round 7.25% twice
in one basket and put two identical rows in the breakdown. Delivery becomes one
more weight in the allocation, so its tax is an *allocation* of the group's
single rounded figure — the same footing as a line's.

This was cheap **only because M8 rounded per group rather than per line**. Had it
rounded per line, delivery would have had nowhere to go.

The alternative was measured rather than argued away. Mutating the code to give
delivery a private group produced, for one basket in Germany, **144 instead of
143** for delivery's tax share and two 19% rows where there is one 19% rate.

Discounts do **not** apply to delivery. "Free shipping over $50" is a *rate
rule*, in shipping-service's table beside the other rates, so `discountMinor`
keeps meaning exactly one thing: money off the goods. The threshold compares
against the **discounted** subtotal — verified live, 5 mugs (gross 6250,
discounted 4812) is charged and 6 mugs (discounted 5875) is free.

---

## Decision 4 — Creating a shipment is not a saga step

`PROJECT_PLAN.md` §7 numbers the saga as nine steps, and step 9 is "shipping |
Create shipment".

**Rejected.** The only question that decides whether something belongs in a saga
is *what has to be undone if it fails*. For steps 1–8 there is always an answer:
release the stock, refund the card, give the coupon use back. For "create a
shipment" the answer is **nothing**. The customer has paid, the stock is
committed, the order is `CONFIRMED`. A shipping service down for ten minutes is
not a reason to refund a completed order; it is a reason to create the shipment
ten minutes later, which redelivery already does.

**Chosen:** the saga ends at `CONFIRMED` exactly as before — no saga test changed
— and shipping-service consumes `order.confirmed` as a fact. M9 added that event
as a leaf event and said nothing drives the saga from it; M10 is what makes that
sentence pay off.

A shipment that never gets created despite retries is an **operational** failure,
which is what M18's dead-letter queue and M19's observability are for. That gap
is real and is recorded rather than papered over.

### The corollary: no `FULFILLED` order status

`PROJECT_PLAN.md` §6 sketches `PENDING → AWAITING_PAYMENT → PAID → FULFILLED`.
Having orders consume `shipment.delivered` to move the order to `FULFILLED`
would mean either reopening a finished state machine or mutating an order
outside it. Both are worse than the alternative: the order page reads the
shipment from the service that owns it. Delivery is a shipping fact.

### Two independent idempotency guards

The bus delivers at least once, and two parcels is a real cost:

1. `processed_events` — a redelivered event **id** is a no-op.
2. `shipments.order_id` UNIQUE — a **republish** with a new event id, which the
   marker cannot catch, is refused by the database.

M9 proved guard 1 alone is insufficient. Both were exercised here and each fired
for its own case: the redelivery logged `Duplicate order.confirmed ignored`, the
republish logged `already has a shipment; nothing created`.

`ON CONFLICT DO NOTHING RETURNING id` rather than catching a unique violation —
a violation aborts the whole Postgres transaction, so the marker written
afterwards would never commit and the event would redeliver forever (HANDOFF §5).

---

## Smaller decisions, recorded because someone will ask

- **`order.confirmed` gained shipping fields.** M8 kept `order.created`'s payload
  minimal because adding money would have been for an imagined future. Here a
  consumer genuinely needs the address, and sending it on the fact fixes it at
  confirmation time rather than letting a callback read whatever the order says
  later.
- **Weight bands are half-open `[min, max)`.** Closed ranges leave a gap at every
  boundary, and a basket landing in one gets no rate at all — a 404 on a valid
  checkout, for a case nobody tests by accident.
- **Zones are chosen by an explicit integer priority**, not by deriving
  specificity from which fields are set (the trick `resolveTaxRule` uses). That
  works for tax because a rule has two nullable dimensions; a zone is a *set* of
  countries, and "how specific is `['DE','FR','NL']`?" has no honest answer.
- **Overlapping weight bands are permitted**, because excluding them needs the
  `btree_gist` extension for one table. Selection stays deterministic — highest
  matching `min_weight_g` wins — so an overlap gives a defined answer rather than
  whichever row came back first.
- **`free_over_minor` compares against the discounted subtotal.** "Free over $50"
  is ambiguous to everyone including whoever writes the next seed.
- **Three shipment states, not four.** `docs/M10_SHIPPING_PLAN.md` §8 sketched a
  `cancelled` state; nothing reaches it, because shipments are created from
  `order.confirmed` and there is no returns flow until R4.
- **`shipment.dispatched` / `shipment.delivered` are emitted with no consumer**
  until M15. This is an imagined future and is labelled as one — the narrow
  argument is that the outbox is already here for the consumer, and a state
  transition leaving no trace on the bus is the one thing this project has
  consistently treated as a defect. Deleting the two appends costs nothing else.

---

## What this costs, and what is not covered

- **Volumetric weight is out of scope.** A large light parcel is charged on its
  actual weight. Real carriers do not work that way; it needs three more columns
  and a second rating rule.
- **`shipments.weight_g` is always 0.** The order does not carry the basket's
  weight — it was pricing's input, never frozen — so a guess would be worse than
  a zero.
- **Dispatch and deliver are protected by nothing but a valid JWT.** There are no
  roles until M16, exactly like "create product" and "adjust stock". Not new
  debt, but two more endpoints on the pile: anyone with an account can currently
  mark any parcel delivered.
- **One order sits between step 5 and step 6** with a total that includes
  delivery and a `shipping_minor` of 0, because the column did not exist yet. All
  114 orders were audited; that one and 47 pre-M8 orders with a 0/0/0 breakdown
  are the only rows whose stored figures do not add up, and both sets are
  explained. Nothing was backfilled — a guessed breakdown is worse than an
  honest zero.
- **`AddressesService`'s default-switching has no unit test.** It was verified
  live only; covering it needs a database, like M9's concurrency test.

---

## Evidence

### Three regions, hand-computed before being run

One basket — 3 tees, 1 mug, 2 cables, 10047, 1120g — with both seeded
promotions (−688):

| Destination | Rate | Delivery | Delivery tax | Tax | Total | Tax groups |
|---|---|---:|---:|---:|---:|---|
| US-CA | standard | 0 (free) | 0 | 679 | **10038** | 725bp/9359 |
| US-PA | standard | 0 (free) | 0 | 220 | **9579** | 600bp/3666 + 0bp/5693 |
| DE | standard | 1499 | 239 | 1734 | **10858** | 1900bp/10858 incl. |
| US-CA | express | 1299 | **0** | 679 | **11337** | 725bp/9359 + **0bp/1299** |
| US-PA | express | 1999 | **120** | 340 | **11698** | **600bp/5665** + 0bp/5693 |
| DE | express | 2499 | 399 | 1893 | **11858** | 1900bp/11858 incl. |

The three tax treatments are visibly different: California puts delivery in its
own 0% group, Pennsylvania merges it into the 6% group with the goods (base
5665 = 3666 goods + 1999 postage, rounded once), Germany keeps one inclusive
group whose total equals the gross.

**US-CA 10038 and US-PA 9579 are identical to the figures M8 recorded**, because
that basket earns free shipping in both — a useful accident showing the change
is additive.

### Mutation testing

Every rule that decides what a customer pays was mutated to confirm the tests
catch it:

| Mutation | Tests failed |
|---|---|
| delivery gets its own tax group | 3 (incl. DE tax share 144 vs 143) |
| delivery taxed at the category rule, not the general one | 3 |
| `shippingTaxable` ignored | 4 |
| delivery's tax rounded on its own | 2 |
| delivery left out of `netMinor` | 9 |
| half-open band `>` becomes `>=` | 3 |
| free threshold `>=` becomes `>` | 2 |
| zone priority `>` becomes `<` | 8 |

The first band mutation initially failed only **one** test, and not the boundary
test — which passed because the overlap tie-break returned the right band
anyway. `bandsCovering` is exported so a test can assert exactly one band
matches. A test that has never failed is a test you cannot trust.

### The lifecycle, against the live stack

`order.confirmed` published onto `commerce.events` for a real order driven
through the real saga (with the Stripe webhook stood in for):

```
first delivery            -> 1 shipment
same event id             -> 1  (processed_events marker)
new event id, same order  -> 1  (UQ_shipments_order)
deliver while PENDING     -> 409
dispatch                  -> dispatched, dispatched_at set, shipment.dispatched published
dispatch again            -> 409
deliver                   -> delivered, delivered_at set, shipment.delivered published
deliver again             -> 409  (terminal)
cancelled order           -> no shipment at all
```

### Constraints, proved by inserting rows that should fail

Two shipments for one order; `delivered` with no timestamps; `pending` *with* a
`dispatched_at`; negative cost; band `max <= min`; negative weight; threshold of
zero; two defaults for one customer; a three-letter country code. Each with a
positive control, so the rejections mean something.

---

## A bug worth recording

**A missing `destination` returned 500, not 400.** `@ValidateNested()` passes on
`undefined`, so the request reached the controller, dereferenced
`body.destination.country` and crashed. That reports the caller's mistake as our
fault *and* tells them to retry something that can never work — the same
category as the 503-vs-400 fix in `CatalogClient`. `@IsNotEmptyObject()` fixes
it.

**A signed-in shopper with an empty address book had no way to choose a
destination.** The first version of the cart page swapped the region selector
for the address picker whenever someone was signed in — strictly worse than what
M8 gave them. A pricing test that signs in caught it. Both controls now render
until an address exists.

**Two E2E tests failed because a helper navigated away mid-request.** Clicking
add-to-cart starts a POST; `page.goto` before it settles aborts it, and the cart
is then empty for reasons that look like a page bug. `cart.spec.ts` has waited
on the confirmation notice since M7 for exactly this reason.

---

## Related

- **ADR-0007** — round once per tax group; pricing owns money. Decision 3 is that
  rule applied to postage, and it only works because of how ADR-0007 grouped.
- **ADR-0008** — the two-guard idempotency pattern reused here.
- **ADR-0003** — orchestration over choreography. Decision 4 is the boundary of
  that orchestration: the saga stops at `CONFIRMED`, and what follows is
  reaction, not orchestration.
- `docs/M10_SHIPPING_PLAN.md` — the design argued before any of this was built.
