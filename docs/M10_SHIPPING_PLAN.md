# M10 — Shipping: implementation plan

**Written:** 2026-09-09
**Status:** Draft, for review. Nothing built yet.
**Milestone:** M10, fourth of R2

Read §3, §4, §5 and §7 before agreeing to this.

- **§3** contradicts `IMPLEMENTATION_PLAN.md`: it says shipping-service owns
  customer addresses, `PROJECT_PLAN.md` §5 says users-service does, and they
  cannot both be right. I recommend users-service.
- **§4** is the constraint that shapes the whole milestone. Shipping cost changes
  the total, and M8 spent a milestone establishing that **exactly one thing**
  computes a total. Adding shipping the obvious way re-opens that split.
- **§5** asks whether shipping is taxed. It is the only genuinely hard piece of
  arithmetic here, and it is easy to not notice at all.
- **§7** argues that creating a shipment is **not** a saga step, and that this is
  the first thing in the project that happens *after* the saga is done.

---

## 1. What M10 is for

M8 was arithmetic. M9 was concurrency. M10 is **modelling a thing that outlives
the request that created it.**

Everything the project has built so far reaches a terminal state within minutes:
an order confirms or cancels, a reservation commits or expires, a coupon use is
spent or given back. A shipment does not. It is created when an order confirms
and then sits in `PENDING` for a day, `DISPATCHED` for a week, and reaches
`DELIVERED` because a human or a courier's webhook said so — long after every
saga, every reservation and every Stripe intent involved has finished.

That has two consequences worth naming up front, because they are the actual
learning content of this milestone:

1. **The shipment lifecycle is not a saga.** There is nothing to compensate. A
   parcel that is late is not a transaction that must be unwound; it is a fact
   that has not happened yet. Recognising which of these two shapes a problem
   has is more useful than knowing how to write either one.
2. **Shipping is the first consumer of a fact rather than a command.** M9 added
   `order.confirmed` as a leaf event and said "nothing drives the saga from
   this". M10 is what makes that sentence pay off — a second service reacts to
   how an order ended, and the saga does not know or care that it did.

M10 is also the milestone that finally justifies §5 of the M8 plan. Since M8 the
tax destination has travelled on the request with a store default behind it,
because *nothing in this system knew a customer's address*. That was always
labelled as a placeholder for M10. Here it stops being one.

`PROJECT_PLAN.md` §11 lists M10 as **cuttable** — "flat shipping rate instead."
That is the fallback if this runs long, and §13 keeps it available: the zone and
weight tables are step 3, and everything before them works with a flat rate.

---

## 2. Decisions already taken

These follow from what exists and are not worth re-arguing.

| Decision | Choice | Why |
|---|---|---|
| New service | `shipping-service`, port **3008** | `IMPLEMENTATION_PLAN.md` Appendix B already reserves the port. Rates and shipments are a distinct aggregate with a distinct lifecycle. |
| Database | Its own Neon database — the **eighth** | Every service owns its own. (Handoff §10 says "a ninth"; there are seven today, so this is the eighth. Minor, but see §12 — the count matters for the Neon plan.) |
| Which event it consumes | **`order.confirmed`** | The plan says `order.paid`. No such event exists and never has. `order.confirmed` is the same fact, emitted by the saga in the same transaction as the status change, and it has existed since M9. |
| Money | Integer minor units; ADR-0007's rounding rules apply unchanged | Shipping cost is money like any other. |
| Worked example to copy | `pricing-service` | Newest service with an outbox, a consumer and `processed_events`. Copy its `docker-compose.yml` block, its `typeorm.config.ts` (**including `OutboxEventEntity` and `ProcessedEventEntity`** — handoff §5) and its Dockerfile. |
| Idempotency | `handleOnce` marker **plus** a status guard | M9 proved the marker alone is not enough: a republished event with a *new* id gets past it. Same belt-and-braces here — `shipments.order_id` UNIQUE is the guard. |

---

## 3. Where addresses live — the two plans disagree

`IMPLEMENTATION_PLAN.md` §3:

> shipping-service; **customer addresses**; rate calculation by weight/zone

`PROJECT_PLAN.md` §5:

> users-service | 3001 | Auth, customers, **addresses**, wishlists

Both are load-bearing sentences in documents this project follows, and they
assign the same table to two different services.

### I recommend users-service

An address book is a **profile** concern. It belongs to a customer, it is
edited on an account page, it outlives every order, and the next three things
that will want it — order confirmation emails (M15), a returns address, an
admin's customer view (M17) — are not shipping concerns either.

shipping-service does not need the address book at all. It needs two things,
and neither is an address:

- **a destination** (country, region, postcode) to pick a zone, and
- **a frozen snapshot** on the shipment, so a parcel's label does not change
  when the customer edits their address next year.

That is the same shape as `order_items` copying sku and price, and as M8
freezing tax onto the order. The thing that gets used is copied at the moment of
use; the thing that is edited lives with its owner.

Putting the book in shipping-service would also mean a customer cannot see their
saved addresses unless the shipping service is up, and would make
shipping-service the second service in this project storing personal data — a
boundary worth not blurring before M16 adds authorisation.

### The cost of this choice, stated honestly

Checkout gains one more synchronous read (`GET /users/me/addresses`) before it
can pre-fill anything. That is a read, on a page, before anything commits — the
cheapest category of coupling in this system, and the same argument that made
the catalog and pricing lookups acceptable (handoff §7).

**If you would rather follow `IMPLEMENTATION_PLAN.md` literally** and put
addresses in shipping-service, say so — it keeps M10 inside one new service and
touches users-service not at all, which is a real simplification for a milestone
that is already the widest in R2. I think it puts the table in the wrong place
for the sake of a smaller diff, but it is defensible and reversible.

Whichever way this goes, it needs a line in `IMPLEMENTATION_PLAN.md` §3 as a
correction, the way M8's and M9's corrections are recorded.

---

## 4. Shipping cost must go *through* the quote, not around it

This is the most important decision in the milestone, and the obvious
implementation is the wrong one.

The obvious one: `OrdersService.create()` gets a quote from pricing, asks
shipping for a rate, and adds the two numbers together.

That re-creates the exact defect M8 existed to remove. Before M8, orders priced
the basket and the cart page priced the basket, and the way you discover two
implementations of a total disagree is a customer seeing one number and being
charged another. M8 deleted `priceItems()` so there would be exactly one. If
orders sums `quote.totalMinor + rate.costMinor`, then orders can produce a total
the cart page cannot, and the storefront has to reproduce the same addition to
show it — two implementations again, differing only in that the new one looks
trivial. Trivial arithmetic diverges too, and §5 is about to make it not
trivial.

### What I recommend instead

**pricing-service asks shipping-service for the rate, and folds it into the
quote.** `POST /pricing/quote` keeps being the single answer to "what does this
basket cost", and gains a shipping section:

```
storefront ─┐
            ├─> POST /pricing/quote ──> catalog   (prices, weights)
orders  ────┘         │
                      └────────────────> POST /shipping/rates
```

This is precisely the shape M8 chose when it made pricing read catalog itself
rather than having orders pass prices in, and ADR-0007's reasoning transfers
without modification.

pricing is also the service already holding what a rate needs. It has just
fetched every product in the basket, so it knows the total weight; it has just
computed the discounted subtotal, so it knows whether "free over $50" applies.
Orders knows neither without asking someone.

### What it costs

A quote now needs catalog **and** shipping to be up, where before it needed only
catalog. `CatalogClient`'s 503-vs-400 distinction (handoff §7, fixed during M8)
must be copied into the new `ShippingClient`: an unreachable shipping service is
`503 Could not price this order right now`, not a `400` telling a customer their
valid basket is malformed.

The one place I would accept degradation instead: if shipping is down, a **quote
for browsing** could show shipping as "calculated at checkout" rather than
failing the page. `POST /orders` must never fall back — an order with a guessed
shipping cost charges the wrong amount. I suggest not building that fallback in
M10 and noting it; a half-priced cart page is a subtler failure than a broken
one.

---

## 5. Is shipping taxed? (yes, and it is not free to get right)

The question nobody asks until an accountant does. The real answers differ by
jurisdiction, which is exactly the sort of thing this project has decided to
model properly once already:

- **US**, roughly: shipping is taxable in some states and not others, and in
  some it depends on whether it is separately stated. `US-CA` and `US-PA` are
  both seeded, and they genuinely differ in real life.
- **EU**: delivery is ancillary to the supply and carries the goods' VAT rate,
  and the price the customer sees **includes** it — the same inclusive/exclusive
  split ADR-0007 already handles.

### What I recommend

Shipping becomes **its own tax group** at the destination's general rate — the
rule with `category IS NULL`, which `resolveTaxRule()` already selects as the
fallback — with a per-rule flag saying whether shipping is taxable there.

Concretely, in `quote.ts`:

- `QuoteInput` gains `shipping?: { costMinor: number; taxable: boolean }`.
- The shipping cost joins the grouping in step 3 as a base with no line indexes.
- Step 4 rounds it exactly once, like every other group, and it reaches
  `netMinor` and `totalMinor` through the same addition.
- `pricesIncludeTax` applies to it unchanged, so DE's inclusive VAT backs out of
  the shipping price rather than being added on top — for free, because the
  group machinery already does that.

The grouping code is written against a `Group` with `baseMinor` and
`lineIndexes`, so a group with an empty `lineIndexes` costs one guard in the
allocation step and nothing else. This is a genuinely small change **because M8
rounded per group instead of per line**. Had it rounded per line, shipping would
have had nowhere to go. Worth noticing.

- `tax_rates` gains `shipping_taxable boolean not null default true`.
- Discounts do **not** apply to shipping. Order-scope discounts allocate across
  line subtotals and should keep doing exactly that. "Free shipping over $50" is
  a *rate rule*, not a discount — it belongs in shipping-service's table beside
  the other rates, and it keeps `discountMinor` meaning one thing.

**The cheap alternative:** do not tax shipping in M10, record it as a known
simplification, fix it in M11. It is one line of scope. I do not recommend it —
an untaxed shipping line makes the M8 acceptance figures wrong in a milestone
whose whole point was that they were right — but if time runs short this is the
piece to cut, not the zone table.

---

## 6. Nothing in this system knows what anything weighs

"Rate calculation by weight/zone" needs a weight. `ProductEntity` has `sku`,
`slug`, `name`, `description`, `priceMinor`, `currency`, `categoryId`, `active`.
There is no weight anywhere in the project.

So M10 adds `weight_grams integer not null default 0` to catalog's `products`,
updates the seed with real-ish weights (a t-shirt ~180g, a mug ~400g, a cable
~90g), and carries it through `PricedProduct` in pricing's `CatalogClient` —
which is already fetching these products, so this is a field on an existing
call, not a new one.

Two details:

- **Default 0, not null.** M8's precedent: add columns with safe defaults so
  existing rows stay valid. A zero-weight product falls into the lightest band
  and ships, rather than failing a quote.
- **Grams, integer.** Same discipline as minor units, same reason. No floats
  anywhere near a number that gets banded and charged for.

Volumetric/dimensional weight is the obvious extension and is out of scope. Note
it and move on.

---

## 7. Creating a shipment is not a saga step

`PROJECT_PLAN.md` §7 lists the saga as nine steps, and step 9 is
"shipping | Create shipment". I think that numbering is misleading and following
it literally would be a mistake.

Ask the compensation question, which is the only question that decides whether
something belongs in a saga: **if this step fails, what has to be undone?**

For steps 1–8 there is always an answer — release the stock, refund the card,
give the coupon use back. For "create a shipment" the answer is *nothing*. The
customer has paid, the stock is committed, the order is `CONFIRMED`. A shipping
service that is down for ten minutes is not a reason to refund a completed
order; it is a reason to create the shipment ten minutes later.

So:

- The saga **ends at `CONFIRMED`**, exactly as it does today. `SagaStep.DONE`
  keeps meaning what it means, and no saga test changes.
- shipping-service **consumes `order.confirmed`** and creates a `PENDING`
  shipment. If it fails, the message is nacked and redelivered; the bus is
  at-least-once and the consumer is idempotent, so the retry *is* the recovery.
- A shipment that never gets created despite retries is an **operational**
  failure — what M18's dead-letter queue and M19's observability exist for. Note
  it as a gap rather than inventing a compensation for it.

Worth an ADR paragraph, because "why is shipping not in the saga when the plan
numbered it step 9" is exactly the question a reviewer asks.

### The corollary: no `FULFILLED` order status in M10

`PROJECT_PLAN.md` §6 sketches `PENDING → AWAITING_PAYMENT → PAID → FULFILLED`.
It is tempting to have orders consume `shipment.delivered` and move the order to
`FULFILLED`.

I recommend **not** doing that in M10. The saga is `DONE` at `CONFIRMED`; making
a finished saga's order move again means either reopening the state machine or
mutating an order outside it, and both are worse than the alternative — the
order page reads the shipment from shipping-service and displays its status.
Delivery is a shipping fact. Let shipping own it.

### Do `shipment.dispatched` / `shipment.delivered` get emitted?

Handoff §7 is self-critical about `cart.abandoned` having no consumer — "the one
piece of M7 written for an imagined future". The same test applies here, and
honestly: **nothing consumes these until M15 notifications.**

I still recommend emitting them, on a narrower argument than "M15 will want
them": the outbox is being wired into this service anyway (it needs
`processed_events` to consume `order.confirmed`, and those arrive as one
pattern), and a state transition that leaves no trace on the bus is the one
thing this project has consistently treated as a defect. But it *is* an imagined
future, it should be labelled as one in the ADR, and **if you would rather not
emit them, cut them** — nothing else in M10 depends on it.

---

## 8. Shape of the changes

```
apps/shipping-service/                     ** NEW — the eighth service, port 3008 **
  src/
    modules/shipping/
      shipping-zone.entity.ts
      shipping-rate.entity.ts
      shipment.entity.ts
      shipping.service.ts          zone match, band lookup, free-shipping threshold
      rates.controller.ts          POST /shipping/rates        (read-only, no writes)
      shipments.controller.ts      GET  /shipping/shipments/:orderId
                                   POST /shipping/shipments/:id/dispatch  (ops)
                                   POST /shipping/shipments/:id/deliver   (ops)
    events/
      shipping-events.listener.ts  consumes order.confirmed -> creates a shipment
      outbox.entity.ts, processed-event.entity.ts, outbox.relay.ts
    database/migrations/, database/seed.ts   (zones + rate bands)

apps/users-service/
  src/modules/addresses/           ** NEW — §3 **
    address.entity.ts, addresses.controller.ts, addresses.service.ts

apps/catalog-service/              weight_grams on products, seed updated (§6)
apps/pricing-service/              ShippingClient; shipping folded into the quote (§4, §5)
                                   tax_rates.shipping_taxable
apps/orders-service/               shipping_minor + frozen address on the order
apps/api-gateway/                  /shipping route (users routes already covered)
storefront/                        address form + rate picker at checkout
```

### Data

```
shipping_zones
  id            uuid pk
  code          varchar UNIQUE          'US-CA', 'US', 'EU', 'ROW'
  name          varchar
  countries     text[]                  ISO alpha-2; empty = catch-all
  regions       text[]  null            state/province codes, null = whole country
  priority      integer not null        most specific wins; ROW is lowest

shipping_rates
  id              uuid pk
  zone_id         uuid fk -> shipping_zones(id)
  code            varchar               'standard' | 'express'
  name            varchar               what the customer reads
  min_weight_g    integer not null default 0
  max_weight_g    integer null          null = no upper bound
  price_minor     integer not null
  free_over_minor integer null          discounted subtotal at or above this ships free
  currency        char(3) not null
  active          boolean not null default true
  UNIQUE (zone_id, code, min_weight_g)
  CHECK (max_weight_g IS NULL OR max_weight_g > min_weight_g)
  CHECK (price_minor >= 0)

shipments
  id            uuid pk
  order_id      uuid UNIQUE             one shipment per order, ever — the guard (§2)
  customer_id   uuid
  status        enum(pending, dispatched, delivered, cancelled)
  rate_code     varchar                 frozen: what was chosen and charged for
  cost_minor    integer not null        frozen
  weight_g      integer not null        frozen: what it was rated on
  address       jsonb not null          frozen snapshot (§3)
  carrier       varchar null
  tracking_code varchar null
  dispatched_at, delivered_at  timestamptz null
  created_at, updated_at
  INDEX (customer_id, created_at DESC)

-- users-service
customer_addresses
  id            uuid pk
  user_id       uuid fk -> users(id) ON DELETE CASCADE
  label         varchar null            'Home', 'Work'
  recipient     varchar not null
  line1, line2  varchar
  city          varchar not null
  region        varchar null            state/province — feeds the tax destination
  postcode      varchar null
  country       char(2) not null
  phone         varchar null
  is_default    boolean not null default false
  created_at, updated_at
  INDEX (user_id)

-- orders-service, added columns (M8 precedent: safe defaults)
orders.shipping_minor       integer not null default 0
orders.shipping_rate_code   varchar null
orders.shipping_address     jsonb null      -- null for every order before M10
```

Notes on that schema:

- **Zones by priority, not by cleverness.** `US-CA` beats `US` beats `ROW`. One
  integer and an `ORDER BY priority DESC LIMIT 1` is the whole algorithm; it is
  inspectable in the seed and trivially testable. Resist anything more
  expressive.
- **Weight bands are half-open** `[min, max)`, with `max NULL` as the top band.
  Closed ranges leave a gap at the boundary, and the gap is where the bug lives.
- **`free_over_minor` compares against the *discounted* subtotal**, not the
  gross one. Whichever is chosen, write it in the ADR — "free over $50" is
  ambiguous to everyone, including the person who seeded it.
- **`shipments.address` is jsonb, deliberately.** It is a frozen document, never
  queried by field; normalising it here would be normalising a copy.

### Where shipping enters

```
POST /shipping/rates    { destination, weightGrams, subtotalMinor }  -> options[]
POST /pricing/quote     { ..., shippingRateCode? }   folds the chosen (or cheapest) in
POST /orders            { ..., shippingRateCode?, shippingAddressId? }   freezes it
GET  /users/me/addresses, POST, PATCH, DELETE
GET  /shipping/shipments/:orderId
```

`POST /shipping/rates` writes nothing — the same property as
`GET /pricing/coupons/:code`. Browsing must never create a shipment, for the
same reason quoting must never spend a coupon.

**Which rate applies if the caller names none?** The cheapest. Not the first
row, not "standard" by name — cheapest, deterministically, ties broken by code.
An order that silently picks express is an order that overcharges.

### Ops endpoints, and what protects them

`dispatch` and `deliver` are staff actions, and there are **no roles until M16**.
They will be protected by nothing but a valid JWT, exactly like "create product"
and "adjust stock" already are (handoff §9). Not new debt, but M10 adds two more
endpoints to the pile, so the M16 entry should say so.

---

## 9. Storefront

Checkout stops being "pick a region from a dropdown".

- **An address step**: pick a saved address or enter a new one. The chosen
  address's `country`/`region` become the quote's `destination` — the field M8
  built and left to a selector.
- **`RegionSelector` stays.** It is still right for a **guest** browsing a cart
  before signing in, a state M7 deliberately supports. It becomes the fallback,
  not the mechanism.
- **A rate picker** on the checkout page, each option with its price, re-quoting
  on change — the same re-quote path the coupon input already uses.
- **The totals block gains a Shipping line**, between discount and tax. "Free"
  when `costMinor` is 0, not "0.00" — a shopper who qualified for free shipping
  should be told they did.
- **The order page shows shipment status**, read from
  `GET /shipping/shipments/:orderId` and polled with the existing order poll.

`CartProvider` already holds the destination and the coupon code; the address id
and rate code go beside them.

---

## 10. Verification

The M8/M9 pattern: compute the expected figures by hand first, then run them.

**Rating (unit tests, no database):**

- Zone selection: `US-CA` beats `US` beats `ROW`; a country with no zone at all
  gets `ROW`.
- Band boundaries: a basket weighing **exactly** `max_weight_g` falls in the
  *next* band up. The off-by-one here is the likeliest bug in the milestone.
- `free_over_minor`: one cent below the threshold pays; exactly at it does not.
- Zero-weight basket (every product still at the default) still rates.

**Tax on shipping (unit tests) — hand-computed before running:**

- `US-CA` 7.25%, shipping taxable: shipping forms a second group, and the group
  totals sum to the order total.
- `US-PA`, shipping **not** taxable: shipping contributes to `netMinor` and
  nothing to `taxMinor`.
- `DE` 19% inclusive: the shipping price is backed *out* of, not added to.
- The invariant that catches the whole class: **`totalMinor` equals
  `netMinor + taxMinor`, and the tax groups sum to `taxMinor`**, with shipping
  present.

**End to end, against the live stack:**

- A confirmed order produces exactly one `PENDING` shipment, with the address
  and cost frozen on it.
- `order.confirmed` **redelivered** produces no second shipment — the marker.
- `order.confirmed` **republished with a new event id** produces no second
  shipment — the `order_id` UNIQUE guard. M9 proved the marker alone misses this.
- A **cancelled** order produces no shipment at all.
- `dispatch` then `deliver` walk the lifecycle; `deliver` on a `PENDING`
  shipment is refused rather than silently skipping a state.
- One basket, three regions: three different totals, each matching the API, each
  including shipping — M8's test extended.

---

## 11. Definition of Done

- [ ] `shipping-service` on 3008, own Neon database, healthy in `docker compose ps`
- [ ] Addresses CRUD, scoped to the caller — another customer's address id is a 404, not a 403
- [ ] Rates by **weight and zone**, seeded and inspectable
- [ ] `POST /shipping/rates` writes nothing
- [ ] Shipping cost is in `POST /pricing/quote`, and orders does **no arithmetic of its own**
- [ ] Shipping tax correct in all three seeded regions, hand-computed first (§5)
- [ ] `weight_grams` on catalog products, seed updated
- [ ] Shipment created from `order.confirmed`; duplicate delivery **and** republication both no-ops
- [ ] Lifecycle `PENDING → DISPATCHED → DELIVERED`, illegal transitions refused
- [ ] `shipping_minor`, `shipping_rate_code` and the frozen address on the order; pre-M10 orders unchanged
- [ ] Migrations reversible, verified against a **throwaway Postgres** — never the real database (handoff §9)
- [ ] Storefront: address step, rate picker, shipping line, shipment status
- [ ] `npm run lint`, `npm run test:all`, `gen:spec` + `gen:types`, `scan-secrets.sh` all green
- [ ] `scripts/gen-api-spec.sh` gains `[shipping]=3008`; `test:all` and `build:all` gain the service
- [ ] Playwright: checkout with an address, and the shipping line matching the API
- [ ] **ADR-0009** recording §3, §4, §5 and §7
- [ ] Corrections written into `IMPLEMENTATION_PLAN.md` §3 (`order.paid`, address ownership, shipping-in-the-quote)

---

## 12. Before starting

1. **Confirm an eighth Neon database can be created.** Handoff §4 gives the
   prerequisite as "a Neon account (5 projects)" and there are already seven.
   Whatever arrangement makes that work needs to stretch to one more, and
   finding out it does not *after* writing the service is an unpleasant way to
   spend an evening.
2. **Decide §3** (addresses in users-service or shipping-service) and **§5** (tax
   on shipping, or a documented simplification). Everything else follows.
3. **Roll the Stripe test key** — handoff §9, outstanding since 2026-09-04,
   leaked into transcripts twice. It keeps being deferred to the next milestone.
4. **Rotate the cart-service Neon password** — same list, same reason.
5. `git config core.hooksPath .githooks` if this is a fresh clone.

---

## 13. Suggested order of work

One commit per step. Steps 1–5 are the milestone; 6–8 are the finish.

1. **Scaffold `shipping-service`** — copy pricing's structure, compose block
   (`start_period: 90s`), Dockerfile, `typeorm.config.ts` **with the outbox
   entities**, `.env.example`, gateway route, `gen-api-spec.sh` entry, root npm
   scripts. Healthy container, `/ready` responding, nothing else. Verify by
   standing it up, not by reading it.
2. **Zones, rates, migrations, seed** — with the `CHECK` constraints, each one
   proved against a **throwaway Postgres** by inserting a row that should be
   rejected. M9 step 1 did this and it is the cheapest hour in the milestone.
   Test the `down` migration here too.
3. **Rating** — `POST /shipping/rates`, unit tests for zone priority, band
   boundaries and the free-shipping threshold. No consumers, no shipments yet.
4. **`weight_grams` in catalog** and through pricing's `CatalogClient`. Small,
   and it unblocks step 5.
5. **Shipping in the quote** — `ShippingClient` in pricing (with the 503-vs-400
   distinction), `shipping` in `QuoteInput`, its own tax group,
   `tax_rates.shipping_taxable`. Hand-compute the three regional totals
   **before** running them, the way M8 did.
6. **Addresses in users-service**, and `shipping_minor` + the frozen address on
   the order. Orders passes the rate code through and adds nothing up itself.
7. **The consumer and the lifecycle** — `order.confirmed` → shipment,
   `processed_events` + the `order_id` guard, dispatch/deliver, and the events
   from §7 if they survive review. Verify by publishing genuine events onto
   `commerce.events`, as M9 step 5 did.
8. **Storefront and ADR-0009** — address step, rate picker, shipping line,
   shipment status, Playwright.

If it runs long, stop after step 5 and take `PROJECT_PLAN.md` §11's flat-rate
fallback for the rest: an order that charges a correct total including shipping
is worth more than a shipment lifecycle nothing yet reads.
