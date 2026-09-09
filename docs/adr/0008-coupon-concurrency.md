# ADR-0008 — Claim a coupon with one atomic statement, and hold it like stock

**Date:** 2026-09-09
**Status:** Accepted
**Milestone:** M9

## Context

M8 was arithmetic: get the number right. M9 is **concurrency**: get it right when
fifty people do the same thing at once.

A coupon is the first genuinely contended, finite resource in this project.
Stock is finite too, but it is spread across products and reservation windows; a
coupon is a single row that everyone hits the moment it appears somewhere
public. `PROJECT_PLAN.md` §10 lists M9 among the four milestones that must never
be cut, and the acceptance criterion is deliberately unforgiving:

> 50 parallel redemptions of a 10-use coupon yield exactly 10.

Not "about ten". Not "ten, when we ran it".

There was also a warning close to hand. M8's end-to-end testing uncovered a lost
update in inventory's stock counter that had been there since M3 — two
transactions read the same number, each subtracted, one write vanished. Nobody
noticed for months because nothing contended for it hard enough. A coupon is
contended on day one.

---

## Decision 1 — One atomic conditional UPDATE, not optimistic locking

`IMPLEMENTATION_PLAN.md` was explicit:

> **optimistic locking on `coupons.version`**

We did not do that, and the reason was measured rather than argued.

### The evidence

The naive implementation — read `used_count`, check it against `max_uses`,
write the incremented value back — was built **first, on purpose**, and the load
test run against it. Same test, same coupon, 50 parallel attempts:

```
                          granted   refused   used_count   redemption rows
naive read-check-write         50         0            6                50
atomic conditional UPDATE      10        40           10                10
```

Fifty people received a coupon limited to ten. On top of that, the counter read
**6** against 50 redemption rows: 44 increments were lost as well.

**The most instructive part is what the database constraint did not do.**
`CHK_coupons_within_max_uses` was in place the whole time and never fired,
because every writer wrote a small value — 1, 2, 3. The constraint guards the
*counter*, and the counter had stopped describing reality. A constraint catches
a wrong value; it cannot catch a wrong read.

### What replaced it

```sql
UPDATE coupons
   SET used_count = used_count + 1, version = version + 1
 WHERE id = $1
   AND active
   AND (max_uses IS NULL OR used_count < max_uses)
   AND (starts_at IS NULL OR starts_at <= now())
   AND (ends_at   IS NULL OR ends_at   >= now())
RETURNING id
```

`rowCount` is 1 if a use was available and 0 if it was not. Postgres serialises
concurrent updates to the same row, so the condition is evaluated against the
committed value **at the moment of the write** rather than against something
read earlier. There is no window, no retry loop, and nothing that only
misbehaves under load. Fifty attempts yield ten by construction rather than by
convergence.

### Why not optimistic locking

It also works, with a retry loop — and the retry loop is the part that is easy
to write subtly wrong and hard to prove right, because it only misfires under
contention. With 50 simultaneous attempts on the last use, 49 lose the race and
retry, burning most of their work discovering they lost.

`version` is kept, but for what optimistic locking is genuinely good at: **edits
to the coupon itself**. Two admins changing `max_uses` at once is a rare
conflict where the loser should be told rather than silently retried.

### The method, not just the result

Building the broken version first is what ADR-0002 did for the saga, and it is
why that document is the strongest in this repo: it contains the failure, pasted
in, rather than a description of one. The naive code did not survive. The
numbers did.

---

## Decision 2 — Hold, commit, release — the same lifecycle as stock

The plan required a redemption to be "released when a saga compensates" but did
not say *when* a use is spent. Three options:

- **At order creation.** Every abandoned checkout burns a use.
- **At confirmation.** Nothing is wasted, but fifty people can all be told their
  coupon applied and forty then fail *after paying* — the worst possible moment.
- **Hold at creation, commit at confirmation, release on cancellation.**

The third was chosen, because this project already has that pattern working:

```
inventory:  available -> reserved -> committed   (or released / expired)
coupon:                  HELD     -> COMMITTED   (or RELEASED)
```

Reusing the shape means the saga's existing compensation fires at exactly the
right moments, `used_count` means "held or committed" — which is what a shopper
should be told is unavailable — and anyone who has read inventory already knows
how this works.

**Quoting never redeems.** The cart page re-quotes on every change, so a quote
that consumed a use would empty a ten-use coupon by browsing. `POST /orders` is
the only place a use is claimed.

### Abandoned checkouts

Inventory answers this with a 15-minute expiry sweep. A second sweep was
deliberately **not** built: an order whose reservation lapses *is* cancelled, so
the existing inventory expiry already releases coupons indirectly, through
`order.cancelled`. Worth stating out loud, because it looks like an omission.

---

## Decision 3 — The saga had to start announcing its terminal states

Releasing a redemption needs to know an order died, and nothing said so. Orders
emitted five events, all either the creation fact or commands aimed at another
service; the saga reached CONFIRMED and CANCELLED silently.

Pricing could have listened to `inventory.release_requested`, and that would
have been wrong: it is a **command addressed to inventory**, and the naming
convention in HANDOFF §3 exists precisely so a routing key tells you the
direction of control. Eavesdropping on someone else's instruction works right up
until the day inventory stops needing one.

So `order.confirmed` and `order.cancelled` are emitted from all four places an
order reaches a terminal state, in the same transaction as the status change.
Both are **leaf events** — nothing consumes them to drive the saga forward — so
no transition or compensation path changed. M15's notifications and M14's
recommendations both want exactly these two.

---

## What this costs, and what is not covered

**The per-customer limit is best-effort.** It is enforced by reading, so one
customer submitting two orders in the same instant could pass it twice. That is
a far narrower race than the global one — it needs the same person racing
themselves — and it cannot over-redeem the coupon, because the atomic claim
still holds the global line. The exact fix for the common
`per_customer_limit = 1` case is a partial unique index on
`(coupon_id, customer_id) WHERE status <> 'released'`; it was left out because it
does not generalise to limits above 1 and this milestone's criterion is the
global count.

**`pricing-service` gained an outbox it does not use.** ADR-0007 recorded that
this service had no events on purpose. M9 added `processed_events`, which is used
immediately, and `outbox`, which is not — nothing here publishes yet. It arrives
with its sibling because the two are one pattern and a relay polling an empty
table costs nothing, exactly as cart-service did in M7.

---

## Evidence

### The concurrency test

`apps/pricing-service/test/coupons.concurrency.spec.ts`, against real Postgres.
It skips itself unless `COUPON_TEST_DATABASE_URL` is set, so `npm run test:all`
stays green and database-free.

- 50 genuinely parallel holds via `Promise.all`, not a loop
- the whole scenario repeated 5 times, because a race that passes once has
  proved nothing
- asserts the **invariant**, not just the count: `used_count` must equal the
  number of non-released redemption rows
- it talks to `CouponsService` directly rather than over HTTP, because 50
  parallel HTTP requests would also be testing the gateway's rate limiter —
  which in M8 produced failures that looked exactly like concurrency bugs

### The lifecycle, against the live stack

A real order carrying `SAVE10USES`, then genuine events published onto
`commerce.events` the way M3's duplicate-delivery test was done:

```
before:                  used_count=1  redemption=held
order.cancelled:         used_count=0  redemption=released   USE RETURNED
same eventId again:      used_count=0  IGNORED (processed_events)
NEW eventId, same order: used_count=0  IGNORED (status guard)
```

The last line is the one a marker table cannot catch, and the reason `release()`
only acts on a redemption still HELD.

### Through the API and the browser

| Check | Result |
|---|---|
| `GET /pricing/coupons/:code` | valid code resolves; `NOPE` → "We do not recognise that code." |
| Quote **without** a code | discount 0 — coded discounts stay out of the automatic set |
| Quote **with** a code | discount applied, **no use consumed** |
| `POST /orders` with a code | order stores the discount, `used_count 0 → 1`, one HELD row |
| Browser | a bad code prices the basket and explains itself; a good one discounts it; removing it puts the price back |

---

## A bug worth recording

The consumer failed with `this.subQuery is not a function`, which reads exactly
like the two-copies TypeORM trap in HANDOFF §5. It was not. `OutboxEventEntity`
and `ProcessedEventEntity` had simply never been registered in pricing's
`typeorm.config`, so the DataSource had no metadata for the table `handleOnce`
writes to.

Time went into comparing typeorm versions across three services and tracing
module resolution before the answer turned out to be two missing lines that
cart-service has had since M7. Nothing in typecheck or the unit tests would have
caught it; only running it did.

---

## Related

- `docs/M9_COUPONS_PLAN.md` — the design, and §3/§4/§5 where these were argued
  before any code was written
- ADR-0002 — the precedent for building the wrong version first
- ADR-0003 — the saga this now emits terminal facts from
- ADR-0007 — why pricing had no events until now
