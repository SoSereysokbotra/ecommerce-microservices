# M9 — Coupons: implementation plan

**Written:** 2026-09-08
**Status:** Complete. All seven steps of §11 built, verified and committed.
Decisions recorded in ADR-0008.
**Milestone:** M9, third of R2

Read §3, §4 and §5 before agreeing to this. §3 recommends **not** using the
locking mechanism the plan names, and proposes proving why by building the wrong
one first — the method ADR-0002 established. §4 is a gap: nothing in this system
announces that an order was cancelled, so there is currently no way to release a
redemption. §5 decides *when* a coupon is spent, which is the question the whole
milestone turns on.

---

## 1. What M9 is for

M8 was arithmetic: get the number right. M9 is **concurrency**: get the number
right when fifty people are doing it at once.

A coupon is the first thing in this project with a genuinely contended,
finite resource attached to it — "ten uses, first come first served". Stock is
finite too, but stock is spread across products and reservation windows; a
coupon is a single row that everyone hits simultaneously the moment it appears
on social media.

The acceptance criterion is deliberately brutal and is the deliverable:

> 50 parallel redemptions of a 10-use coupon yield exactly 10.

Not "about ten". Not "ten, when we ran it". Exactly ten, repeatably, and
demonstrably wrong without the mechanism.

`PROJECT_PLAN.md` §10 lists M9 among the four milestones that must **never be
cut**, because it carries a learning objective the rest of the project does not.
That objective is not "use optimistic locking" — it is *know how to make a
contended counter correct, and know how to prove it*.

M8's end-to-end testing is a useful warning here. It found a lost update in
inventory's stock counter that had been there since M3: two transactions read
the same number, each subtracted, and one write vanished. Nobody noticed for
months because nothing contended for it hard enough. A coupon will be contended
on day one.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Where coupons live | `pricing-service` | It already owns discounts and the quote. A coupon is a discount with a code and a limit; splitting it out would put two things that compose into two services. |
| Relationship to M8 discounts | Same table, `code` becomes non-null | M8 deliberately left `discounts.code` present and always NULL to mark this boundary. A coupon is an automatic promotion that had to be asked for. |
| Uniqueness of redemption | `coupon_redemptions.order_id` UNIQUE | Named in the plan, and it is the guard that makes redemption idempotent under an at-least-once bus. |
| Money arithmetic | Unchanged | `quote.ts` already stacks discounts deterministically and allocates to the penny. A coupon slots into that ordering; M9 adds no new arithmetic. |
| Currency, rounding, tax | Unchanged from M8 | ADR-0007 stands. |

---

## 3. Change I recommend: an atomic conditional UPDATE, not optimistic locking

The plan is explicit:

> **optimistic locking on `coupons.version`**

I think that is the wrong mechanism for this particular job, and I want to argue
it before building it.

### What optimistic locking would do here

Read the coupon (version 7, used 9 of 10), check there is a use left, increment,
write back with `WHERE version = 7`. If someone else got there first the write
matches zero rows and you retry.

With 50 simultaneous attempts on the last use, 49 of them lose the race, retry,
lose again, retry. It is correct *if* the retry loop is written correctly, and
it burns most of its work discovering it lost. Worse, the correctness now lives
in a retry loop — the easiest thing in the world to write subtly wrong, and the
hardest to prove right, because the failure only appears under contention.

### What I recommend instead

One statement that cannot be raced:

```sql
UPDATE coupons
   SET used_count = used_count + 1, version = version + 1
 WHERE id = $1
   AND used_count < max_uses
```

`rowCount` is 1 if you got a use and 0 if the coupon was exhausted. Postgres
serialises concurrent updates to the same row internally, so the check and the
increment cannot be separated by another transaction. There is no read, no
window, no retry, and no loop to get wrong. Fifty parallel attempts produce
exactly ten rows updated, by construction rather than by convergence.

This is also the shape M8 taught us to prefer. Inventory's bug was a
read-modify-write across a gap; the fix was to close the gap with a lock. Here
we can avoid opening it at all.

### Keep the `version` column anyway

`version` still earns its place, just not for redemption: it guards **edits to
the coupon itself** — an admin changing `max_uses` or the window while
redemptions are in flight. That is a genuine optimistic-locking case, because
the conflict is rare and the loser should be told rather than retried.

### Prove it, do not assert it — build the wrong one first

The most valuable thing this milestone can produce is not a working coupon; it
is **evidence**. ADR-0002 is the strongest document in this repo precisely
because it contains the broken state, pasted in, rather than a description of
one.

So: implement the naive read-modify-write first, run the 50-parallel load test
against it, and record the actual over-redemption — 13 uses of a 10-use coupon,
whatever the number turns out to be. Then switch to the atomic update, run the
identical test, and record exactly 10.

That gives ADR-0008 the same standing as ADR-0002, and it means the mechanism is
justified rather than cargo-culted. It costs perhaps an hour.

**If you would rather follow the plan literally and use optimistic locking with
retries, say so** — it is defensible, it is what many production systems do, and
the load test proves either implementation. I would still want the naive version
measured first.

---

## 4. The gap: nothing announces that an order was cancelled

The plan requires the redemption to be "released when a saga compensates". There
is currently no way to know that it did.

Orders emits exactly five events, and every one of them is either a creation
fact or a command to another service:

```
order.created
payment.requested            inventory.commit_requested
payment.refund_requested     inventory.release_requested
```

There is **no `order.cancelled` and no `order.confirmed`.** The saga reaches its
terminal states silently — `onInventoryReleased` sets the order to CANCELLED and
writes nothing to the outbox. Today nothing needs to know, so nothing was
emitted. M9 is the first consumer of that fact.

Three options:

1. **Emit `order.cancelled` and `order.confirmed` from the saga's terminal
   transitions.** Both are genuine facts about the past, correctly named, and
   they commit in the same transaction as the status change like every other
   event in this project.
2. **Have pricing consume `inventory.release_requested`.** Wrong: that is a
   *command aimed at inventory*, and the naming convention in HANDOFF §3 exists
   precisely so that the routing key tells you the direction of control. Pricing
   would be eavesdropping on someone else's instruction.
3. **Poll orders for status.** No.

**Recommendation: option 1.** It is a small change to two saga transitions and
it is needed beyond M9 — M15's notification service wants exactly these two
events, and M14's recommendations want `order.confirmed`. Emitting them now,
with one consumer, is better than retrofitting them later with four.

Note the cost honestly: it adds two events to the saga, and the saga is the most
carefully tested code in the repo. They are *leaf* emissions — nothing consumes
them to drive the saga forward — so no transition changes and no compensation
path moves.

---

## 5. When is a coupon actually spent?

This is the question the milestone turns on, and the plan does not answer it.

An order takes time to become real: created → stock reserved → paid → confirmed,
with several ways to fail. A coupon is finite. So when does a use get consumed?

**(a) At order creation.** Simple, but every abandoned checkout burns a use
until something gives it back. With a popular coupon, the last ten uses could be
held by ten people who never pay.

**(b) At confirmation.** Nothing is wasted, but nothing is *held* either:
fifty people can all be told "your coupon applied" at checkout, and forty of
them get an error after paying. That is the worst possible moment to fail.

**(c) Hold at creation, commit at confirmation, release on cancellation.**

**Recommendation: (c)** — and note that this project already has exactly this
pattern, working, in inventory. Stock is reserved when the order is created,
committed when it is paid, and released when the saga compensates or the hold
lapses. A coupon redemption is the same shape with a different resource:

```
inventory:  available -> reserved -> committed        (or released / expired)
coupon:                   HELD     -> COMMITTED       (or RELEASED)
```

Using the same lifecycle means the mental model is already in the reader's head,
the saga's compensation already fires at the right moments, and `used_count`
means "held or committed" — which is exactly what a shopper should be told is
unavailable.

### What about abandoned checkouts?

Inventory answers this with a 15-minute expiry sweep, and that answer is
available here too — an expiry on HELD redemptions, swept the same way. I
suggest **deferring it**: it is a second sweep, a second background job, and a
second set of failure modes, and M9 is already the concurrency milestone. A held
redemption is released when the order is cancelled, and an order whose
reservation lapses *is* cancelled — so the existing inventory expiry already
releases coupons indirectly, through `order.cancelled`.

That is worth stating out loud in code, because it looks like an omission
otherwise.

---

## 6. Shape of the changes

Nothing new is scaffolded. M9 is the first milestone in R2 that adds no service.

```
apps/pricing-service/
  src/
    modules/coupons/
      coupon.entity.ts
      coupon-redemption.entity.ts
      coupons.service.ts          hold / commit / release — the contended part
      coupons.controller.ts       GET /pricing/coupons/:code  (validate, no write)
    modules/pricing/
      quote.ts                    a coupon becomes one more DiscountRule
      pricing.service.ts          resolves a code, holds it when pricing an order
    events/                       ** NEW — pricing joins the event system **
      outbox.entity.ts, outbox.relay.ts
      processed-event.entity.ts
      handlers/order-lifecycle.handler.ts
  test/
    coupons.concurrency.spec.ts   the load test
```

**pricing-service gains an outbox and a consumer**, which M8 deliberately left
out because a quote changes no state. A redemption *is* state, and it must be
released when a saga compensates, so the wiring arrives now — exactly as
`ADR-0007` and `app.module.ts` said it would. cart-service remains the closest
worked example.

### Where a coupon enters

```
POST /pricing/quote     { items, destination?, couponCode? }   read-only, never redeems
GET  /pricing/coupons/:code                                    validate for the UI
POST /orders            { items, destination?, couponCode? }   this is what holds a use
```

The asymmetry is the important part: **a quote never spends a coupon.** The cart
page re-quotes on every change, and a quote that consumed a use would empty a
coupon by browsing.

### Data

```
coupons
  id            uuid pk
  code          varchar UNIQUE (citext or upper-cased on write — see below)
  discount_id   uuid fk -> discounts(id)     the money part, reusing M8
  max_uses      integer      null = unlimited
  used_count    integer not null default 0
  per_customer_limit integer null
  starts_at, ends_at  timestamptz null
  active        boolean not null default true
  version       integer      for edits to the coupon, not for redemption (§3)
  CHECK (used_count >= 0)
  CHECK (max_uses IS NULL OR used_count <= max_uses)   -- the invariant, at the database

coupon_redemptions
  id            uuid pk
  coupon_id     uuid fk
  order_id      uuid UNIQUE            -- one redemption per order, ever
  customer_id   uuid
  status        enum(held, committed, released)
  amount_minor  integer                -- what it actually took off, frozen
  created_at, updated_at
  INDEX (coupon_id, customer_id)       -- per-customer limit lookup
```

Two notes on that schema:

- **The `CHECK (used_count <= max_uses)` is the point.** M8 taught that a
  constraint turns silent corruption into a loud failure — inventory's
  `CHK_stock_reserved_non_negative` is what made a lost update visible at all.
  If the concurrency control is ever wrong, this fails the transaction rather
  than overselling the coupon.
- **Codes are case-insensitive.** Customers type `save10`, marketing prints
  `SAVE10`. Upper-case on write and compare exactly; a `citext` column is the
  alternative and pulls in an extension for one field.

---

## 7. The load test — the actual deliverable

A unit test cannot prove this. It needs real concurrency against real Postgres.

```
Given  a coupon with max_uses = 10
When   50 requests redeem it simultaneously
Then   exactly 10 succeed, 40 are refused,
       used_count = 10, and 10 coupon_redemptions rows exist
```

Points that decide whether the test is worth anything:

- **Genuinely parallel**, not a loop. `Promise.all` over 50 requests, ideally
  against the running service through the gateway.
- **Repeat it.** A race that passes once has proved nothing. Run the whole
  scenario 10 times in the suite.
- **Run it against the naive implementation first** and record the failure
  (§3). A concurrency test that has never failed is a test you cannot trust.
- **Assert the invariant, not just the count**: `used_count` must equal the
  number of non-released redemption rows. That catches a class of bug the
  count alone misses.
- Watch the gateway rate limit — 50 parallel requests against a 100/min default
  will throttle. `RATE_LIMIT_MAX` exists as of M8; the test must set it or go
  direct to the service. This bit us for hours in M8 and would look like a
  concurrency bug here.

`k6` is listed in Appendix A for this milestone. I suggest a Jest integration
test instead: it can assert database invariants afterwards, it runs in the
normal suite, and k6 earns its place in M22 where throughput is the question.

---

## 8. Storefront

- A coupon input on the cart page, next to the totals.
- Applying re-quotes with `couponCode` and shows the discount as its own line —
  `appliedDiscounts` already renders per-discount, so a coupon needs no new
  layout, only a name.
- A rejected code says **why**: expired, fully used, minimum not met, or already
  used by this customer. "Invalid code" for all four is the version people
  complain about.
- The code is held in `CartProvider` alongside the destination, and passed to
  `POST /orders` at checkout.

---

## 9. Definition of Done

Per IMPLEMENTATION_PLAN §1.6, plus what is specific here:

- [ ] **50 parallel redemptions of a 10-use coupon yield exactly 10**, repeatably
- [ ] The same test **fails against the naive implementation**, with the number recorded
- [ ] `coupon_redemptions.order_id` UNIQUE proven by replaying `order.created`
- [ ] A cancelled order releases its redemption; the use returns
- [ ] A quote with a coupon **never** writes a redemption
- [ ] Per-customer limit enforced
- [ ] Expired / not-yet-started / inactive coupons refused, with distinct reasons
- [ ] Migrations reversible — verified against a **throwaway Postgres**, not the real database (M8 §step 5 learned this the hard way)
- [ ] `order.cancelled` / `order.confirmed` emitted; existing saga tests still green
- [ ] Swagger + types regenerated; CI staleness check green
- [ ] ADR-0008 recording §3 and §5, with the load-test evidence

---

## 10. Before starting

1. **Roll the Stripe test key** — handoff §9, still outstanding, leaked in
   transcripts twice.
2. **Decide §3** (atomic update vs optimistic locking) and **§5** (when a use is
   spent). Everything else follows from those two.
3. No new database this time. pricing-service's existing Neon database gains two
   tables.

---

## 11. Suggested order of work

One commit per step.

1. ~~Schema + entities + seed~~ — **done**. Every constraint proved against a
   throwaway Postgres by inserting a row that should be rejected, including the
   11th use of a 10-use coupon.
2. ~~The naive redemption and the load test~~ — **done**, and it over-redeemed
   exactly as predicted: **50 granted** on a 10-use coupon, counter reading **6**
   against 50 rows. That is ADR-0008's evidence.
3. ~~The atomic conditional UPDATE~~ — **done**. Same test: **10 granted, 40
   refused**, counter and rows agreeing, across 5 repeated stampedes.
4. ~~Hold / commit / release, and the terminal saga events~~ — **done**.
   `order.confirmed` and `order.cancelled` are emitted from all four places an
   order reaches a terminal state. 16 saga tests green.
5. ~~pricing joins the event system~~ — **done**. Verified live by publishing
   genuine events onto `commerce.events`: the use came back, a replayed event id
   was ignored by the marker, and a *new* event id for the same order was ignored
   by the status guard.
6. ~~Quote and order integration~~ — **done**. Quoting resolves a code and never
   redeems; `POST /orders` holds once, atomically.
7. ~~Storefront and ADR-0008~~ — **done**. A coupon box that explains *why* a
   code was refused, and 6 pricing browser tests green.

### What went wrong, and is worth knowing

- **`this.subQuery is not a function`** from the consumer. It reads exactly like
  the two-copies typeorm trap; it was `OutboxEventEntity` and
  `ProcessedEventEntity` missing from pricing's `typeorm.config`. Only running it
  found this.
- **TypeORM returns different shapes for INSERT and UPDATE `RETURNING`**, and
  both wrong assumptions fail silently. See the `returning()` helper.
- **A unique violation aborts the whole transaction**, so a compensating
  statement written to run afterwards never executes. `ON CONFLICT DO NOTHING`
  instead of catching.
- Docker Desktop died three times mid-milestone. `docker compose ps -a` first.

Steps 1–3 are the milestone. If time runs short, 4–7 can slip; a coupon that
cannot be over-redeemed is worth more than a coupon with a pretty input box.
