# M8 — Tax and discounts: implementation plan

**Written:** 2026-09-04
**Status:** Proposed. Nothing built yet — this is for review before any code.
**Milestone:** M8, second of R2

Read §3, §4 and §5 before agreeing to this. §3 says the plan's one-line warning
about rounding is *not quite right*, and would produce wrong totals if followed
literally. §4 moves work out of orders-service. §5 is a gap the plan does not
mention at all: nothing in this system currently knows what country the shopper
is in, and tax is a function of exactly that.

---

## 1. What M8 is for

Right now a basket costs the sum of its catalog prices. `OrdersService.create()`
does it in one line:

```ts
const totalMinor = priced.reduce((sum, i) => sum + i.unitPriceMinor * i.qty, 0);
```

That line is the entire pricing engine, and it is wrong in every jurisdiction on
earth. What a customer actually pays is the catalog price, adjusted by whatever
promotions apply, plus whatever tax the destination charges on *that adjusted
amount*, for *that kind of product*.

The milestone is not "add a tax field". It is **the arithmetic of money**:
several inputs at different granularities — per line, per category, per order —
that have to combine into a single integer number of cents which is defensible,
reproducible, and identical whether the storefront computes it for display or
orders-service computes it for the charge.

The reason this is a milestone rather than a function is that money arithmetic
has a failure mode nothing else in this project has. The saga is about failures
you can *see*: a service is down, a card is declined. Pricing fails silently. A
total that is one cent wrong looks exactly like a total that is right, ships,
and is found by an accountant months later.

The second purpose: this is the first service in the project that is a **pure
function with a database attached**. No outbox, no consumers, no saga
participation. Building one of those deliberately is worth doing, so that "every
service needs the outbox" does not become an unexamined habit. See §6.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Money representation | Integer minor units, everywhere, always | Already the rule (IMPLEMENTATION_PLAN §1.5). M8 is where it earns its keep — see §9. |
| Tax rates on disk | Integer **basis points** (`725` = 7.25%) | A `numeric` column invites a float in the code that reads it. Stored this way there is no floating point value anywhere in the pricing path, not even briefly. |
| Currency | **USD only, all three regions** | Tax region and currency are independent, and multi-currency is M11. Mixing them would mean solving FX and zero-decimal currencies (¥) in the same milestone as rounding. Artificial for Germany, but honestly scoped. |
| Rounding mode | **Half-up**, on integers | The commercial convention, and the one a customer checking the arithmetic by hand will use. Banker's rounding is defensible for statistics; it is surprising on a receipt. |
| Quote persistence | The computed quote is **frozen onto the order** | The same principle M11 applies to FX rates: a rate change tomorrow must never re-price an order placed today. |
| Caching of rates | **None** | Rates and promotions are read on every quote. One Neon round-trip per quote is fine at this scale, and a cache is a *correctness* risk — a stale rate is a wrong charge — traded against a performance problem that does not exist yet. |

---

## 3. Change I recommend: "round once, at the end" is too simple

The plan's warning for M8 reads:

> *Watch for:* rounding. Round once, at the end. Test totals across three regions.

The instinct is right and the phrasing is wrong, in a way that produces wrong
totals. You cannot round once for a basket, because **different lines in one
basket can carry different tax rates** — that is the entire point of keying
`tax_rates` by category. There is no single "the end" to round at.

The correct rule is: **round once per tax rate group.** Group the lines by the
rate that applies to them, sum each group's taxable base exactly, and round that
group's tax exactly once. A basket with three rates rounds three times, and no
more.

That this matters is not theoretical. Rounding each line separately and summing
diverges from rounding the group, using this project's own seeded prices, at
7.25%:

```
unit  qty   per-line sum   per-group   diff
 600   x6        264          261       +3
1250   x6        546          544       +2
1400   x6        612          609       +3
2250   x6        978          979       -1
```

Six sticker packs are three cents apart depending on where you round, and the
error does not even have a consistent sign — at 2250 the per-line total comes out
*lower*. Both figures are "the tax", both were computed with correct arithmetic,
and only one of them is the amount the customer owes.

A related rule, same family, in §9: an order-level discount must be **allocated
across the lines before tax**, and the allocated parts must sum to exactly the
discount. Otherwise the identical divergence reappears in the discount instead.

**Recommendation:** state the rule in the code as *round once per tax group,
never per line*, with the table above in a comment — because the per-line version
is what someone will later "fix" it to.

---

## 4. Change I recommend: pricing-service owns the whole quote

The plan says "a single `POST /pricing/quote` that orders calls to price a
basket", which leaves open what orders sends. Two shapes:

**(a)** Orders keeps its catalog lookup and sends *priced* lines
(`productId, qty, unitPriceMinor`); pricing only applies tax and discounts.

**(b)** Callers send `productId` and `qty` only; **pricing-service reads catalog
itself** and returns the fully priced basket, including sku and name.

I recommend **(b)**, and consequently that `OrdersService.priceItems()` is
deleted and orders stops calling catalog at all.

The reason is that under (a) two places compute what a basket costs — the
storefront's cart page, which today sums catalog prices in the browser, and
orders-service. They can disagree, and the way you find out is a customer seeing
one number and being charged another. Under (b) there is exactly one
implementation of "what does this basket cost", and both the cart page and orders
get their answer from it. That is the whole reason to make pricing a service
rather than a library.

It also fits what M7 already decided: **the cart deliberately stores no prices**,
so the storefront has no priced lines to send even if we wanted shape (a).

**The honest cost:** order creation currently fails if catalog is unreachable;
under (b) it fails if pricing *or* catalog is unreachable. That is a second hop
in the critical path. I think it is acceptable because it is the same *kind* of
dependency the project already accepted and documented — a **read before anything
commits**, so a failure rejects the request cleanly with nothing half-done
(handoff §7). It adds no new failure *mode*, only one more thing that can be
down. If you would rather not take that, shape (a) is defensible — but then the
cart page's total and the order total must be tested against each other
explicitly, because nothing else will keep them honest.

**This milestone changes `POST /orders`, and that is unavoidable.** M7 went out
of its way not to touch the saga's entry point. M8 cannot: the amount charged has
to include tax, and the amount charged comes from `order.totalMinor`. The change
is confined to `create()` and the order columns — no saga step, no event
sequence, no compensation path is touched. §10 says exactly what moves.

---

## 5. The gap: nothing here knows where the customer is

Tax is a function of destination. This system has no concept of one. There are no
addresses anywhere — `users` holds email, name, password hash, avatar, role, and
nothing else. Addresses arrive in **M10 (shipping)**, two milestones away.

Three options:

1. **The request carries the destination.** `POST /pricing/quote` takes
   `{ items, destination: { country, region } }`, and `POST /orders` takes an
   optional `destination` it forwards. Absent, both fall back to a configured
   store default (`DEFAULT_TAX_COUNTRY` / `DEFAULT_TAX_REGION`).
2. **Add a country to users-service.** Pricing then needs the customer identity
   and a call to users — and guests, who have been able to hold a cart since M7,
   have no country at all.
3. **Wait for M10.** M8 then has one tax region, and its acceptance criterion
   ("order totals correct across three tax regions") cannot be demonstrated.

**Recommendation: option 1.** Pricing stays stateless about identity, which is
what keeps it testable; guests get correct totals; and when M10 lands, the
shipping address simply becomes the thing that populates `destination` — nothing
inside pricing-service changes. The destination is persisted on the order
alongside the frozen quote, so a historical order records the jurisdiction it was
taxed in.

It also gives the acceptance criterion a way to be shown live: a region selector
on the cart page — three regions, three totals, one basket.

---

## 6. Shape of the service

Follows IMPLEMENTATION_PLAN §1.1, with one deliberate omission.

```
apps/pricing-service/          port 3007
  src/
    main.ts, app.module.ts, app.controller.ts   (/health, /ready)
    config/database.config.ts
    database/
      migrations/
      seed.ts                     tax rates + promotions, idempotent
      typeorm.config.ts
    modules/pricing/
      pricing.controller.ts       POST /pricing/quote (+ read-only rate lists)
      pricing.service.ts          loads rules, calls the calculator
      catalog.client.ts           the one cross-service read
      tax-rate.entity.ts
      discount.entity.ts
      dto/
      quote.ts                    ** the pure calculator **
      money.ts                    divRound, allocate — integer helpers
  test/
    quote.spec.ts
    money.spec.ts
```

**No `events/` directory.** pricing-service publishes nothing and consumes
nothing: no outbox, no relay, no `processed_events`, no saga participation. A
quote is a pure read that changes no state, so there is nothing to make atomic
and nothing to deduplicate. This is worth doing consciously — five of the six
existing services have that wiring and it would be easy to paste it in out of
habit. **M9 will add it**, because a coupon redemption *is* state and must be
released when a saga compensates. That is the right time, not now.

`quote.ts` and `money.ts` are **pure functions**, exactly like `cart-merge.ts` in
M7: no database, no HTTP, everything passed in as arguments. All the thinking in
this milestone is arithmetic, and arithmetic should be testable without standing
anything up.

### Gateway

`/api/v1/pricing` already routes to `http://pricing-service:3007` in
`services.config.ts`. As the handoff warned, **the routing is there and the auth
posture is wrong** — the same trap `/cart` fell into in M7. Measured against the
running stack:

```
POST /api/v1/pricing/quote  (no token)     -> 401 Missing authentication token
POST /api/v1/pricing/quote  (valid token)  -> 503 upstream unavailable
```

The 503 confirms routing works. The 401 confirms a guest cannot get a quote — and
since M7, guests have carts, so a guest looking at a cart page needs one.

**Recommendation:** `@OptionalAuth()` on `['pricing', 'pricing/*']`, declared
*before* the guarded `@All` block. Nest matches in declaration order — the same
constraint that already governs the `catalog` and `cart` routes. Not `@Public()`:
a quote needs no identity today, but M9's coupons will be per-customer, and
`@OptionalAuth` already rejects an *invalid* token rather than silently treating
an expired session as a guest.

### Data

```
tax_rates
  id            uuid pk
  country       char(2)          -- ISO 3166-1 alpha-2, e.g. 'US'
  region        varchar null     -- state/province code; null = whole country
  category      varchar null     -- catalog category slug; null = all categories
  rate_bp       integer          -- basis points: 725 = 7.25%
  prices_include_tax boolean     -- see §7
  name          varchar          -- 'California state sales tax'
  unique (country, region, category)

discounts
  id                 uuid pk
  code               varchar null   -- always NULL in M8; see §8
  name               varchar
  type               enum('percentage','fixed')
  value_bp           integer null   -- percentage discounts
  value_minor        integer null   -- fixed discounts
  scope              enum('order','category','product')
  scope_ref          varchar null   -- category slug or product id
  min_subtotal_minor integer not null default 0
  starts_at          timestamptz null
  ends_at            timestamptz null
  active             boolean not null default true
```

`tax_rates` gets **no validity dates**, deliberately. A rate change is rare, and
historical orders are protected by the frozen quote (§10) rather than by dated
rows — so date columns would add a dimension to every lookup in exchange for
nothing. `discounts` *does* get a window, because a promotion that runs for a
week is the normal case rather than the exception.

`CHECK` constraints worth having at the database rather than trusting the caller,
following M7's precedent with `CHK_cart_items_qty_positive`: `rate_bp >= 0`, and
exactly one of `value_bp` / `value_minor` non-null per row.

### Endpoints

```
POST /api/v1/pricing/quote        { items:[{productId, qty}], destination?, currency? }
GET  /api/v1/pricing/tax-rates    read-only, feeds the storefront's region selector
GET  /api/v1/pricing/discounts    read-only, active promotions
```

`quote` is a POST that changes nothing. That is deliberate — a basket does not
fit in a query string — and worth one comment so it does not read as an
oversight.

Response shape, integer minor units throughout:

```jsonc
{
  "currency": "USD",
  "destination": { "country": "US", "region": "CA" },
  "lines": [
    { "productId": "…", "sku": "TSH-BLK-M", "name": "Black Tee (M)", "qty": 3,
      "unitPriceMinor": 1999, "lineSubtotalMinor": 5997,
      "lineDiscountMinor": 600, "taxableMinor": 5397, "taxRateBp": 725 }
  ],
  "subtotalMinor": 10047,
  "discountMinor": 1005,
  "appliedDiscounts": [{ "id": "…", "name": "Spring 10%", "amountMinor": 1005 }],
  "taxBreakdown": [{ "rateBp": 725, "baseMinor": 9042, "taxMinor": 656 }],
  "taxMinor": 656,
  "totalMinor": 9698
}
```

`taxBreakdown` is not decoration: it is the group-level rounding of §3 made
visible, and it is what makes a disputed total checkable without a debugger.

---

## 7. Tax, precisely — and the three regions

### Rate resolution

For each line, find the most specific matching row and stop:

```
(country, region, category)  >  (country, region, null)
                             >  (country, null,   category)
                             >  (country, null,   null)
                             >  no match -> 0%
```

A pure function over the rate rows. "No match is 0%" is a real decision — the
alternative is rejecting the quote. Charging no tax somewhere we have no rule for
is the behaviour a shop wants, and it shows up in `taxBreakdown` as an explicit
0% group rather than being silently absent.

### Inclusive versus exclusive

The one genuinely hard idea in the tax half. In the US, sales tax is **added** to
the displayed price. In the EU and UK, VAT is **already inside** it — the shelf
price is what you pay, and the tax is backed out of it for the tax authority.

Same rate, same product, two different totals:

```
exclusive:  tax = round(base * rate / 10000)            base is net
inclusive:  tax = round(base * rate / (10000 + rate))   base is gross, net = base - tax
```

`prices_include_tax` on the rate row selects between them. Handling only the
exclusive case would make "three tax regions" mean "three different percentages",
which is not much of a test.

### The three regions

Chosen so each adds a dimension the others do not, and so every fact is real:

| Region | Rate | Model | Why this one |
|---|---|---|---|
| **US-CA** | 7.25% | exclusive | The baseline. Tax added on top, one rate for everything. |
| **US-PA** | 6%, **apparel 0%** | exclusive | Same *country*, different region, and a genuine category exemption — Pennsylvania does not tax clothing. Exercises both the region and category dimensions, and our catalog has an `apparel` category to exempt. |
| **DE** | 19% | **inclusive** | VAT is inside the price. Exercises the back-out arithmetic, which nothing else does. |

Prices stay in USD in all three (§2). Slightly artificial for Germany; the
alternative is doing FX in this milestone, which is M11's job.

---

## 8. Discounts, and where M9 begins

**M8 discounts are automatic promotions: no code, no per-customer limits, no
redemption records.** "10% off everything", "$5 off orders over $50", "15% off
drinkware". They apply because the basket matches, and a quote can be recomputed
freely because computing it writes nothing.

**M9 is coupons**: a code the customer types, a usage limit, optimistic locking on
`coupons.version`, a redemption row unique per order, and release on saga
compensation. That milestone is about *concurrency*; this one is about
*arithmetic*. The boundary is exactly "does applying it write anything down" — and
it is worth being strict about, because a `code` column added here for
convenience is how M9's concurrency work quietly starts leaking into M8. The
column exists in the schema (§6) and stays NULL.

### Stacking

If several promotions match, apply them in a deterministic order — percentage
first, then fixed — each against the running subtotal, with the total discount
floored at the subtotal so a basket can never cost less than nothing.
Deterministic order matters: 10% then $5 off is not the same amount as $5 off
then 10%, and "whichever the database returned first" is not an answer.

The simpler alternative is **best-single-discount only**: compute each candidate,
apply the largest. Plenty of real shops do exactly that, and it removes stacking
bugs entirely. I lean to stacking because the interesting part — allocation, §9 —
is identical either way, and stacking is the more general thing to have
understood. Say if you would rather have best-only; it is a smaller change now
than later.

---

## 9. The arithmetic

Two integer helpers, and everything else falls out of them.

```ts
/** Half-up division of integers. Never sees a float. */
function divRound(n: number, d: number): number {
  return Math.floor((n + Math.floor(d / 2)) / d);
}

/** Split `total` across `weights` so the parts sum to exactly `total`. */
function allocate(total: number, weights: number[]): number[];
```

`allocate` is the **largest-remainder method**: take each line's exact share,
floor them all, then hand the leftover pennies out one at a time to the lines with
the largest discarded fraction. It exists because an order-level discount has to
be pushed down onto the lines *before* tax — a line's tax is charged on what that
line actually cost after the discount — and the pieces must add back up to the
discount exactly. Rounding each share independently loses or invents cents.

### The pipeline

1. **Line subtotals.** `unitPriceMinor * qty`. Exact integers; nothing to round.
2. **Discounts** against the running subtotal (§8), then `allocate()` the total
   discount back across lines in proportion to their subtotals.
3. **Group by resolved tax rate.** Sum each group's taxable base exactly.
4. **Round once per group** (§3), inclusive or exclusive per §7.
5. **Total** = net + tax. One addition of already-rounded integers.

Rounding happens at exactly two places — step 2's allocation and step 4's
per-group tax — and nowhere else. Everything before them is exact integer
arithmetic.

### Worked example

The basket: 3 × Black Tee (M) @ 1999 (apparel), 1 × Black Mug @ 1250
(drinkware), 2 × USB-C Cable @ 1400 (accessories). Subtotal **10047**. One
promotion: 10% off the order.

These numbers are computed, not hand-derived — a prototype of the algorithm above
produced them, and they are the fixtures the unit tests should assert:

```
Discount 10% of 10047 = 1005  (1004.7, half-up)
  allocated  600 / 125 / 280   -> sums to 1005 exactly
  taxable    5397 / 1125 / 2520 = 9042

US-CA   7.25% exclusive
  tax group   7.25% on 9042 -> 656
  net 9042   tax  656   TOTAL  9698

US-PA   6% exclusive, apparel exempt
  tax group   0.00% on 5397 -> 0
  tax group   6.00% on 3645 -> 219
  net 9042   tax  219   TOTAL  9261

DE      19% inclusive
  tax group  19.00% on 9042 -> 1444   (backed out of the gross)
  net 7598   tax 1444   TOTAL  9042
```

The DE line is the one to stare at. Its total equals the taxable base, because the
tax was already inside the price — the customer pays 9042 either way, and 1444 of
it belongs to the tax authority. A *different* total there than the base would
mean the inclusive arithmetic is wrong.

### Cases the unit tests must cover

| Case | Expected |
|---|---|
| Single line, no discount, exclusive | `subtotal + round(subtotal * rate)` |
| Six units at 600, US-CA | **261**, not 264 (§3) |
| Mixed categories, one exempt | two groups in `taxBreakdown`, one at 0 |
| Inclusive region | `total == subtotal`; `net + tax == total` |
| Order discount across 3 lines | allocated parts sum to the discount exactly |
| Discount larger than subtotal | discount capped; total 0, never negative |
| Percentage + fixed stacked | deterministic order, documented |
| `min_subtotal_minor` not met | promotion not applied |
| Expired / not-yet-started promotion | not applied |
| Empty basket | zeros, not an error |
| No tax rule for the destination | 0% group, quote still returned |
| Product missing from catalog | 404 naming the product id, not a silent drop |
| Rounding invariant, **property test** | for any basket: `sum(lines.taxable) + tax == total`, and `sum(allocated) == discount` |

The property test is worth the extra dependency. Money bugs live in the inputs
nobody thought to write down.

---

## 10. What changes in orders-service

The order stops storing one number and starts storing the quote.

**Migration** (reversible, per §1.6):

```
orders + subtotal_minor  integer not null default 0
       + discount_minor  integer not null default 0
       + tax_minor       integer not null default 0
       + tax_country     char(2) null
       + tax_region      varchar null
       (total_minor stays, and stays the amount charged)

order_items + line_discount_minor integer not null default 0
            + tax_rate_bp         integer not null default 0
            + tax_minor           integer not null default 0
```

Defaults of 0 make it a safe migration over existing rows: pre-M8 orders keep
their totals and read as "no tax, no discount", which is exactly what they were.

**In `create()`:** `priceItems()` — the catalog loop — is replaced by one call to
`POST /pricing/quote`, forwarding the correlation id the way the catalog call
does today. The quote's `lines` supply sku, name and unit price for the
`order_items` snapshot; its totals populate the new columns. Nothing else in the
method moves: the order row, the saga start and `order.created` still commit in
the one transaction.

**The frozen quote is the point.** `order_items` already copies sku, name and
price at purchase time, because an order is a record of what was bought at a price
the customer agreed to. Tax and discount are the same kind of fact and get the
same treatment: change a rate tomorrow and every historical order is unaffected,
because nothing re-reads `tax_rates` to display an order.

`payment.requested` already carries `order.totalMinor`, so the amount Stripe
charges becomes tax-inclusive with **no change to payments-service**. Verify that
against a real test-mode intent rather than assuming it — it is the one place
where an M8 mistake turns into a wrong charge.

**Should `order.created` carry the tax breakdown?** No. Its consumer is inventory,
which cares about product ids and quantities. Adding money to it would be payload
for an imagined future — the same trap §7 of the M7 plan flagged.

---

## 11. Storefront

- The cart page stops summing prices in the browser and calls
  `POST /pricing/quote` instead. It currently computes `product.priceMinor * qty`
  client-side; that is the second pricing implementation §4 exists to delete.
- Subtotal / discount / tax / total, with the tax line labelled by region —
  "VAT (19%)" versus "Sales tax (7.25%)". Inclusive and exclusive should not read
  identically when they mean different things.
- A **region selector** on the cart page, persisted in `localStorage` beside the
  cart token. This is what makes the acceptance criterion demonstrable: one
  basket, three regions, three totals, live.
- Checkout sends the chosen `destination` with `POST /orders`.
- The order page shows the stored breakdown, never a recomputed one.

`formatMoney` in `storefront/lib/types.ts` divides by 100 unconditionally. That is
fine for USD and stays fine for M8 — flagged because it is a real
zero-decimal-currency bug waiting for M11, not something to fix here.

---

## 12. Definition of Done

Per IMPLEMENTATION_PLAN §1.6, plus what is specific here:

- [ ] Quote works **through the gateway**, signed in *and* as a guest
- [ ] Migrations reversible in both services (`down` implemented and actually run)
- [ ] `quote.ts` and `money.ts` unit-tested across every row in §9
- [ ] **Order totals correct across all three regions** — the acceptance criterion,
      verified end to end, not only in unit tests
- [ ] A real Stripe test-mode payment charges the **tax-inclusive** amount
- [ ] A pre-M8 order still reads correctly after the migration
- [ ] Swagger captured (`gen:spec` needs `pricing:3007` added to
      `scripts/gen-api-spec.sh`), types regenerated, CI staleness check green
- [ ] `/health` and `/ready` correct; `/ready` checks Postgres only
- [ ] ADR-0007 for the §3 rounding rule and the §4 ownership decision
- [ ] `docs/DEPLOYMENT.md` and `deploy/railway/pricing-service.json` —
      **and the still-missing `cart-service.json`** (handoff §8)

---

## 13. Before starting

1. **A seventh Neon database** (`pricing_db` as the project name; the database
   inside it is `neondb`, per handoff §5).
2. **`.env` with the same `JWT_SECRET`** as everything else, plus
   `CATALOG_SERVICE_URL`, `DEFAULT_TAX_COUNTRY`, `DEFAULT_TAX_REGION`.
3. **Add pricing to the root scripts.** `test:all` and `build:all` both need it —
   and note `build:all` is **already missing cart-service** from M7. Worth fixing
   in the same commit.
4. **Outstanding from handoff §9, still not done:** roll the Stripe test key, and
   rotate the cart-service Neon password. Both credentials are readable in chat
   transcripts, and M8 will place real test-mode charges through that key.

---

## 14. Suggested order of work

One commit per step. Each leaves the repo working.

1. **`money.ts` + `quote.ts` and their unit tests.** No service, no database — the
   whole milestone's thinking, testable in isolation. Every row of §9.
2. **Service scaffold, entities, migrations, seed.** Boots on 3007, in
   `docker-compose.yml`, `/health` and `/ready` answering. Seed the three regions
   of §7 and two promotions. Verify `down` by reverting and re-running.
3. **`POST /pricing/quote` + `catalog.client.ts`.** The endpoint end to end
   against the real catalog.
4. **Gateway `@OptionalAuth()`** on `/pricing`, declared before the guarded
   `@All`. Verify a guest gets a quote and an *invalid* token still gets 401.
5. **orders-service migration and the `create()` switch.** Delete `priceItems()`.
   Verify a pre-M8 order still reads correctly.
6. **Storefront: quote-driven totals and the region selector.** One basket, three
   regions, three totals, in a browser.
7. **End-to-end verification and the ADR.** A real test-mode payment for the
   tax-inclusive amount in each of the three regions; Playwright extended;
   ADR-0007 written.

Steps 1 and 2 are independent of everything else and can be done first even if §4
or §5 are still under discussion — the calculator does not care where the
destination came from.
