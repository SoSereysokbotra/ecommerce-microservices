# M11 — Multi-currency: implementation plan

**Written:** 2026-09-10
**Status:** Complete. All eight steps of §13 built, verified and committed.
Decisions recorded in ADR-0010.
**Milestone:** M11, fifth of R2

> **One departure, decided while building.** §7 sketched `GET /pricing/fx-rates`
> as a debugging aid and it was built; §9 said the order page keeps its original
> currency and it does. But §8's payments check needed something §7's data
> section did not list: an **`exponent` column on the order**, so the check has
> two independent sources to compare and the order page can format a historical
> order without re-reading a table that can change. It arrived at step 6.

Read §3, §4 and §5 before agreeing to this.

- **§3** is an audit, and it is the milestone. There are **17 money columns**
  across six services and only four of them say what currency they are in. The
  other thirteen are denominated by assumption.
- **§4** decides *what* gets converted — a unit price, or a total. Converting
  the total is the obvious choice and it quietly undoes ADR-0007.
- **§5** is the trap the plan entry's "minor units audited everywhere" is really
  about: **not every currency has 100 minor units.** Yen has one. This is the
  reason M11 is worth doing at all, and it breaks `formatMoney`, the seed
  output, and every mental model in the codebase.

**M11 is on `PROJECT_PLAN.md` §11's cut list** (item 6: "keep single currency;
minor-unit discipline stays"). §12 keeps that available: steps 1–2 are the audit
and the exponent, and they are worth having even if the rest is cut.

---

## 1. What M11 is for

M8 was arithmetic, M9 concurrency, M10 modelling something that outlives its
request. M11 is **an assumption that was never written down.**

Every amount in this project is an integer number of minor units, and that
discipline has been held rigorously since M0 — no float has ever touched the
pricing path. But "minor units" has quietly meant "hundredths" everywhere, and
nothing says so. `formatMoney` divides by 100. The seed output divides by 100.
Nobody wrote `× 100` as a conversion; they wrote it as a fact.

That is fine until a currency arrives where it is false. **Japanese yen has no
minor unit at all**: ¥1000 is 1000, not 100000. Kuwaiti dinar has three decimal
places. A codebase that divides by 100 will show ¥10.00 for a ¥1000 item and
charge a customer one hundredth of what they owe — and every existing test will
still pass, because every existing test is in dollars.

So the deliverable is not "support EUR". It is:

> The same product, priced in three currencies, one of which has a different
> number of decimal places — and a historical order that never re-prices when
> the rate moves.

The second half is already solved in spirit: M8 froze tax onto the order and M10
froze shipping, for exactly this reason. M11 freezes the rate.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Where FX lives | `pricing-service` | `PROJECT_PLAN.md` §5 assigns it, and it is where the quote is. A rate is an input to pricing a basket, like a tax rule. |
| Table | `fx_rates (base_currency, quote_currency, rate, fetched_at)` | Named in `PROJECT_PLAN.md` §6. |
| The rate is frozen onto the order | Yes | Named in the plan entry, and it is the same freezing pattern M8 and M10 already established. |
| Rounding rules | ADR-0007 stands, unchanged | Round once per tax rate group. §4 is about not breaking it. |
| No new service | Correct | M11 adds a table and an audit, not a boundary. |

---

## 3. The audit — 17 money columns, and what each is denominated in

This is the part the plan entry calls "minor units audited everywhere". It has
to be done first, because §4 and §5 both depend on knowing which numbers are
prices, which are thresholds, and which are computed.

| Column | Service | Carries a currency? | What it is |
|---|---|---|---|
| `products.price_minor` | catalog | **yes** (`currency`) | A price. The source of every other figure. |
| `orders.subtotal_minor` | orders | **yes** (`currency`) | Computed, frozen |
| `orders.discount_minor` | orders | inherits | Computed, frozen |
| `orders.tax_minor` | orders | inherits | Computed, frozen |
| `orders.shipping_minor` | orders | inherits | Computed, frozen |
| `orders.total_minor` | orders | inherits | Computed, frozen |
| `order_items.unit_price_minor` | orders | inherits | A price, frozen |
| `order_items.line_discount_minor` | orders | inherits | Computed, frozen |
| `order_items.tax_minor` | orders | inherits | Computed, frozen |
| `payments.amount_minor` | payments | **yes** (`currency`) | What Stripe is told |
| `refunds.amount_minor` | payments | inherits from payment | What Stripe is told |
| `shipping_rates.price_minor` | shipping | **yes** (`currency`) | A price |
| `shipping_rates.free_over_minor` | shipping | inherits | **A threshold** |
| `shipments.cost_minor` | shipping | inherits | Computed, frozen |
| `discounts.value_minor` | pricing | **no** | **A fixed discount** — "$5 off" |
| `discounts.min_subtotal_minor` | pricing | **no** | **A threshold** — "spend $50" |
| `coupon_redemptions.amount_minor` | pricing | **no** | Computed, frozen |

Three groups, and they behave differently:

- **Prices** (`products.price_minor`, `shipping_rates.price_minor`) are the
  inputs. They are where conversion happens — see §4.
- **Thresholds and fixed discounts** (`free_over_minor`, `min_subtotal_minor`,
  `value_minor`) are the awkward ones. "Spend $50, save $5" has to mean
  *something* to a shopper paying in yen, and nothing currently records that
  these three are dollars.
- **Computed and frozen figures** need nothing except that the currency they were
  computed in is recoverable. It already is, via `orders.currency`.

**The finding that matters:** the three fields in the awkward group are the only
ones with no currency anywhere near them, and they are all in pricing-service.
That is not a coincidence — they were written when there was one currency.

---

## 4. What gets converted: a unit price, not a total

The obvious implementation: compute the whole quote in USD as today, then
multiply `totalMinor` by the rate at the end. One conversion, one rounding.

**I think that is wrong, and it undoes ADR-0007 without looking like it.**

A quote does not return only a total. It returns per-line subtotals, per-line
discounts, per-line tax, a tax breakdown per rate group, a shipping figure — and
orders **freezes all of them** onto `order_items`. Converting only the total
leaves every one of those in dollars against a euro total, so either they get
converted too (rounding each one independently, which is exactly the per-line
rounding M8 spent a milestone removing) or they get allocated down from the
converted total (a second allocation layer stacked on the one that already
exists, with its own leftover pennies).

### What I recommend instead

**Convert the unit price, then run the existing pipeline unchanged in the target
currency.**

```
catalog price  1999 USD
      ↓ × rate, rounded once          ← the only FX rounding
display price  1849 EUR
      ↓
computeQuote(…, currency: 'EUR')      ← untouched: same grouping, same
                                        per-group rounding, same allocation
```

Three things make this the right shape:

1. **Converting a unit price is the same act as a price-book entry.** Real shops
   maintain per-currency prices precisely so that €18.49 is a price rather than
   the residue of an exchange calculation. Converting once, at the product, puts
   the FX rounding exactly where a price book would put it — and means that if
   price books ever arrive, they replace this step and nothing else changes.
2. **Line arithmetic stays exact.** `unitPrice × qty` still holds in the display
   currency, so a customer who multiplies gets the number on the page. Under the
   convert-the-total approach they do not.
3. **ADR-0007 is untouched.** Tax grouping, per-group rounding, discount
   allocation and M10's shipping group all run on integers in the target
   currency, exactly as they do today. `quote.ts` needs **no change at all** —
   which is the strongest evidence this is the right seam.

### What it costs, stated honestly

The euro total is *not* exactly the dollar total times the rate. It is the total
of converted prices. Those differ by a few cents, and the difference is real
rather than an error: it is the same reason a shop's euro prices are not its
dollar prices converted.

**If you would rather convert the total once** and accept the allocation layer,
say so — it makes "the rate used" arithmetically demonstrable on the order,
which has some appeal for an audit. I think it buys that at the cost of the one
rule this project has defended hardest.

### Thresholds convert with the same rate

`min_subtotal_minor`, `free_over_minor` and `value_minor` are converted at quote
time, like prices. This is the least-bad option and it is not very good:
"spend $50, save $5" becomes "spend €46.30, save €4.63", which no marketing
department would ever write.

The alternative is a per-currency row for each threshold — a real price book for
promotions. That is correct and it is a bigger milestone. **Recommendation:
convert, and record the ugliness in the ADR** as the thing a real shop would fix
first.

---

## 5. Not every currency has 100 minor units

This is the part that makes M11 worth building rather than cutting.

| Currency | Exponent | 1000 minor units is |
|---|---:|---|
| USD, EUR | 2 | $10.00 |
| JPY | **0** | **¥1000** |
| KWD, BHD | 3 | 1.000 |

Everything in this project that turns minor units into a displayed number
assumes exponent 2. There are exactly three such places, which is the good news:

- `storefront/lib/types.ts` → `formatMoney`, `amountMinor / 100`
- `storefront/e2e/pricing.spec.ts` → the test helper, same expression
- `apps/shipping-service/src/database/seed.ts` → console output, cosmetic

(`rateBp / 100` in two seeds is basis points to percent, not money. Leave it.)

**Everything else is already safe**, because `money.ts` never divides by 100 — it
divides by `10000` for basis points and by the allocation weights, both of which
are exponent-independent. That discipline is why this milestone is a day's work
rather than a rewrite.

### The proposal

A `currencies` table — code, exponent, name — in pricing-service, and an
`exponent` on the wire in every quote. `formatMoney` takes the exponent instead
of assuming it.

### Converting between different exponents

This is where the arithmetic gets interesting:

```
amountB = amountA × rate × 10^(expB − expA)
```

USD 1999 (exp 2) → JPY (exp 0) at 150.0: `1999 × 150 × 10^-2 = 2998.5 → 2999`.
So ¥2999, not ¥299850 and not ¥29.

**Watch the overflow guards.** `money.ts` throws when a product exceeds
`MAX_SAFE_INTEGER`, deliberately, so this will fail loudly rather than silently —
but it *will* fail if the rate scale is chosen carelessly. A rate stored at
1e8 scale times a 7-digit amount is 10^15-ish and uncomfortably close to the
ceiling.

**Recommendation: do the conversion step in `BigInt`**, and return a `Number`.
It is exact integer arithmetic, it removes the ceiling entirely, and it is
confined to one function. `money.ts` bans floats, not large integers.

The alternative is to store the rate at 1e6 and document the headroom. That
works for realistic amounts and fails for a basket of ten thousand hoodies. I
would rather not have a money function with a documented range.

---

## 6. Where do the rates come from?

The plan entry says "`fx_rates` table with **scheduled refresh**". This project
has no FX API key and adding a paid third-party dependency is scope the
milestone does not need.

**Recommendation:** the table is **seeded** with plausible static rates, and a
scheduled job refreshes it from a configurable provider URL that is **disabled
by default**. The learning content is the pattern — a rate table, refreshed on a
schedule, with the rate used frozen at purchase — not an HTTP call to a vendor.

The job matters even with no provider configured, because it is where the two
real questions live:

- **A refresh must never rewrite history.** Rates are inserted, not updated:
  `fx_rates` is append-only with a `fetched_at`, and a quote reads the newest
  row per pair. An order stores the rate itself, so it is immune either way —
  but an append-only table means "what was the rate on Tuesday" is answerable.
- **A failed refresh must not take the shop down.** A stale rate prices a basket
  slightly wrong; no rate at all prices nothing. The job logs and leaves the last
  known rate in place, and a rate older than a configurable age is a warning, not
  an error.

This mirrors M7's abandonment sweep and M10's reasoning about operational
failures: it belongs in logs and M19's metrics, not in a customer-facing error.

---

## 7. Shape of the changes

```
apps/pricing-service/
  src/modules/currency/               ** NEW **
    currency.entity.ts                code, exponent, name
    fx-rate.entity.ts                 base, quote, rate, fetched_at  (append-only)
    fx.service.ts                     newest rate per pair, convert()
    fx-refresh.job.ts                 scheduled, provider optional
    currency.controller.ts            GET /pricing/currencies
  src/modules/pricing/
    money.ts                          convert() in BigInt (§5)
    pricing.service.ts                converts prices + thresholds before quoting
    quote.ts                          ** unchanged ** — the point of §4
    dto/quote.dto.ts                  currency + exponent + fxRate on the response

apps/orders-service/                  base_currency, fx_rate, fx_rate_at frozen
apps/catalog-service/                 unchanged — products keep one base price
apps/shipping-service/                unchanged — rates keep their own currency
apps/payments-service/                exponent-aware assertion before Stripe (§8)
storefront/                           currency switcher; formatMoney takes exponent
```

### Data

```
currencies
  code        char(3) pk        'USD', 'EUR', 'JPY'
  exponent    smallint not null  2, 2, 0
  name        varchar
  active      boolean
  CHECK (exponent BETWEEN 0 AND 4)

fx_rates
  id            uuid pk
  base_currency char(3) fk -> currencies(code)
  quote_currency char(3) fk -> currencies(code)
  rate_e8       bigint not null    -- rate × 10^8, integer discipline
  fetched_at    timestamptz not null default now()
  source        varchar            -- 'seed', or the provider that supplied it
  CHECK (rate_e8 > 0)
  CHECK (base_currency <> quote_currency)
  INDEX (base_currency, quote_currency, fetched_at DESC)   -- "newest per pair"

-- orders, added columns (M8/M10 precedent: safe defaults)
orders.base_currency  char(3) null    -- what the catalog priced it in
orders.fx_rate_e8     bigint null     -- 10^8 for a same-currency order
orders.fx_rate_at     timestamptz null
```

Notes:

- **`fx_rates` is append-only.** No unique constraint on the pair: a refresh
  inserts a row, and the newest wins. That is what makes "the rate on Tuesday"
  answerable and what stops a refresh from rewriting a figure a quote already
  used.
- **`rate_e8` is a `bigint`**, and the conversion is done in `BigInt` (§5), so
  the scale can be generous without approaching a ceiling.
- **`orders.fx_rate_e8` is nullable, not defaulted to 1e8.** Null means "placed
  before M11", which is a different fact from "placed in the base currency at
  parity". M8 and M10 both made this distinction and it has been useful twice.
- **`CHECK (base <> quote)`** because a USD→USD row would be a second, silent
  path to parity that could disagree with the hardcoded one.

### Where a currency enters

```
POST /pricing/quote   { …, currency? }   defaults to the store base
GET  /pricing/currencies                 feeds the storefront switcher
POST /orders          { …, currency? }   frozen onto the order with its rate
```

---

## 8. Payments, and the one place this could actually cost money

Stripe takes amounts in the **smallest currency unit** — so a JPY charge of
¥2999 is `2999`, not `299900`. Our minor units already are the smallest unit,
so passing them straight through is correct **provided our exponent agrees with
Stripe's.**

It does for USD, EUR and JPY. It would not for a currency where we recorded the
wrong exponent, and the failure mode is charging 100× or 1/100× the intended
amount.

**Recommendation:** payments asserts the amount against the currency's expected
exponent before creating an intent, and refuses rather than guessing. That is a
cheap guard on the one operation in this project that moves real money, and it
is the same instinct as `CHK_coupons_within_max_uses`: make being wrong loud.

Refunds inherit the payment's currency and need no change.

---

## 9. Storefront

- **A currency switcher** in the header, beside nothing else — it is a
  global choice, not a cart one. Stored like the destination is.
- **`formatMoney(amountMinor, currency, exponent)`.** The exponent comes from the
  quote, not from a table in the browser, so there is one source of truth.
  `Intl.NumberFormat` already knows JPY has no decimals; the bug is dividing by
  100 before handing it over.
- **The order page keeps showing the currency it was placed in**, always. An
  order is a record of what was agreed; a customer who switches to EUR must not
  see last month's dollar order restated.
- The cart's existing region selector and address picker are unaffected —
  destination and currency are independent choices, and conflating them
  ("Germany means euros") is a guess that is wrong for every expat.

---

## 10. Verification

Compute expected figures by hand first, then run them — the M8/M10 method.

**Unit, no database:**

- `convert()` across exponents: USD→JPY loses the decimals, JPY→USD gains them,
  USD→EUR keeps them. Hand-computed each way.
- **Round-tripping is not identity**, and a test should say so: USD→JPY→USD does
  not return the original. That is inherent, not a bug, and asserting it stops
  someone "fixing" it later.
- Parity: converting a currency to itself returns the input exactly, with no
  rounding applied.
- The exponent-0 case through the *whole* quote: tax grouping, discount
  allocation and shipping in a currency with no minor unit at all.
- Overflow: a basket large enough to blow a 1e8 rate scale in `Number`
  arithmetic still converts correctly in `BigInt`.

**Against the live stack:**

- **The acceptance criterion**: one product, three currencies, three quotes,
  each hand-checked — and JPY showing no decimal places anywhere.
- A **historical order re-read after the rate changes**: same figures, same
  stored rate. This is the plan entry's "watch for", and it is the one that
  proves the freezing works.
- A basket whose products are all in the base currency but quoted in JPY, then
  ordered — and the Stripe intent carrying `2999`, not `299900`.
- A refresh that fails: the last rate stays, quotes keep working, a warning is
  logged.

---

## 11. Definition of Done

- [ ] `currencies` and `fx_rates`, seeded with USD, EUR and **JPY**
- [ ] **The same product priced in three currencies**, one with exponent 0
- [ ] `formatMoney` exponent-aware; nothing divides money by a literal 100
- [ ] Conversion done in `BigInt`, with the round-trip asymmetry asserted
- [ ] `quote.ts` **unchanged** — if it needed changing, §4 was wrong
- [ ] Thresholds and fixed discounts converted, with the ugliness recorded
- [ ] `base_currency`, `fx_rate_e8`, `fx_rate_at` frozen onto the order
- [ ] **A historical order does not move when a rate changes** — the plan's "watch for"
- [ ] Payments refuses an amount whose magnitude disagrees with its currency's exponent
- [ ] `fx_rates` append-only; a failed refresh leaves the last rate and logs
- [ ] Migrations reversible, verified against a **throwaway Postgres**
- [ ] Storefront: currency switcher; order pages keep their original currency
- [ ] `npm run lint`, `test:all`, `gen:spec` + `gen:types`, `scan-secrets.sh` green
- [ ] Playwright: one basket, three currencies, and JPY rendered without decimals
- [ ] **ADR-0010** recording §4, §5 and §6
- [ ] Correction written into `IMPLEMENTATION_PLAN.md` §3

---

## 12. Before starting

1. **Provision the eighth Neon database** — still outstanding from M10 §12.
   `shipping-service` is pointed at a throwaway Postgres container and its data
   does not survive `docker rm`.
2. **Decide §4** (convert prices or convert the total) and **§5** (`BigInt` or a
   documented rate scale). Everything else follows.
3. **Roll the Stripe test secret key** — HANDOFF §9, outstanding since
   2026-09-04, leaked into transcripts twice. M11 is the milestone that changes
   what gets sent to Stripe, so doing it now is more than housekeeping.
4. **Rotate the cart-service Neon password** — same list.
5. No new database. pricing-service's existing one gains two tables.

---

## 13. Suggested order of work

One commit per step. Steps 1–4 are the milestone; 5–8 are the finish.

1. **The audit** — write down what every one of the 17 money columns is
   denominated in, and add the `currencies` table with exponents. No conversion
   yet. This is the step that is worth having even if M11 is cut.
2. **`convert()` in `money.ts`**, in `BigInt`, with the exponent arithmetic and
   the round-trip asymmetry test. Pure, no database, no service touched.
3. **`fx_rates` + `FxService`** — newest rate per pair, seeded USD/EUR/JPY,
   migrations proved against a throwaway Postgres including the `down`.
4. **Quoting in a currency** — pricing converts prices and thresholds, then calls
   `computeQuote` unchanged. Hand-compute the three-currency figures **before**
   running them.
5. **Freeze it onto the order** — `base_currency`, `fx_rate_e8`, `fx_rate_at`,
   and the test that a historical order does not move when the rate does.
6. **Payments** — the exponent assertion before creating an intent, and a real
   JPY intent verified to carry whole yen.
7. **The refresh job** — scheduled, provider optional, append-only, failure
   leaves the last rate standing.
8. **Storefront and ADR-0010** — currency switcher, exponent-aware formatting,
   Playwright.

If it runs long, stop after step 4 and take `PROJECT_PLAN.md` §11's cut: the
audit and the exponent-aware money helpers are the durable part, and a shop that
prices correctly in one currency is worth more than one that prices ambiguously
in three.
