# ADR-0002 — Why checkout needs a saga

**Date:** 2026-09-01
**Status:** Accepted
**Milestone:** M2

## Context

M2 built checkout the obvious way: a straight line of synchronous HTTP calls
from `orders-service`.

```
price from catalog  ->  reserve stock  ->  charge card  ->  confirm order
```

This was built deliberately, and is thrown away in M3–M5. Its purpose is to
produce evidence for a claim that is otherwise easy to accept on authority and
never really understand: **a business operation spanning several services cannot
be made correct with ordinary error handling.**

The single-database instinct is that a failure rolls everything back. Across
services there is no shared transaction to roll back, and no service can undo
work another has already committed.

## The experiment

Run against the live stack, all six services healthy, on Neon.

### 1. Baseline

Product `BTL-STL-1` (Steel Bottle), one earlier confirmed order already holding
two units:

```
stock: available=48  reserved=2
```

### 2. Kill payments mid-checkout

```
$ docker compose stop payments-service
 Container commerce-payments-service Stopped
```

### 3. Place an order for 5 units

```
$ curl -X POST /api/v1/orders -d '{"items":[{"productId":"a005755b…","qty":5}]}'

  order  01504ba3-f286-4d57-8951-f7af4900586b
  status failed
  reason ENOTFOUND: getaddrinfo ENOTFOUND payments-service
  HTTP 201
```

### 4. The damage

```
stock: available=43  reserved=7
```

`orders_db`:

```
┌────────────┬─────────────┬───────┬────────────────────────────────────────┐
│ id         │ status      │ total │ reason                                 │
├────────────┼─────────────┼───────┼────────────────────────────────────────┤
│ '01504ba3' │ 'failed'    │ 17000 │ 'ENOTFOUND: … ENOTFOUND payments-ser…' │
│ 'dc5a7d82' │ 'confirmed' │  6800 │ ''                                     │
└────────────┴─────────────┴───────┴────────────────────────────────────────┘
```

`inventory_db`:

```
┌────────────┬───────────┬──────────┬─────────┐
│ product    │ available │ reserved │ version │
├────────────┼───────────┼──────────┼─────────┤
│ 'a005755b' │        43 │        7 │       5 │
└────────────┴───────────┴──────────┴─────────┘
```

Five units are reserved against an order whose status is `failed`. The two
databases now disagree about reality, and each is internally consistent.

### 5. Recovery: none

```
$ docker compose start payments-service
  payments-service healthy again
$ sleep 45
stock: available=43  reserved=7
```

Bringing the failed service back changes nothing. There is no retry, no expiry,
no compensating call. `orders-service` logged the problem and moved on:

```
ERROR [OrdersService] Payment failed for order 01504ba3-…; stock reserved in
step 3 is now orphaned and will never be released [1425fbff-…]
```

Worse, the reservation is only a number on the stock row. Nothing records
*which* order those five units belong to, so even a human cannot release them
correctly without reconstructing the link from order history by hand.

### 6. The same happens on an ordinary declined card

The crash above is the dramatic version. The mundane one is worse, because it
needs nothing to go wrong at all. With the stub forced to decline:

```
stock before: available=43  reserved=7

  status failed  reason Payment declined

stock after:  available=40  reserved=10
```

Three more units orphaned. No service crashed, no network failed, nothing
timed out — a customer's card was simply declined, which is a routine outcome
that any shop must handle many times a day. Every declined payment silently
leaks stock.

## What this rules out

**Wrapping the calls in a transaction.** There is nothing to wrap. The stock
change is committed in a different database, by a different process, before the
payment call is even made.

**Rolling back on error.** `orders-service` can roll back its *own* write. It
cannot roll back inventory's.

**Retrying the whole request.** The reservation already succeeded; retrying
would reserve five more units.

**Trying harder not to fail.** The failure mode does not need a crash. A network
partition, a timeout, a deploy, or a full GC pause between step 3 and step 4
produces the same orphaned reservation. Any two-service operation has a window
where one has committed and the other has not.

## Decision

Checkout becomes an **orchestrated saga**: a sequence of local transactions,
each with a compensating action that semantically undoes it.

Orchestration over choreography, because `orders-service` holding an explicit
state machine keeps the flow visible and debuggable. Choreography — each service
reacting to events with no coordinator — is the more elegant answer and a
worthwhile second exercise, but a first implementation should be one you can
read.

Three things follow, and each is a milestone:

- **M3 — transactional outbox.** Step 3 currently succeeds or fails as an HTTP
  call. Events must be written in the same transaction as the business change,
  so a broker outage cannot lose them.
- **M4 — idempotency.** Compensations and retries are delivered at least once.
  Releasing stock twice must not credit ten units, and charging twice must not
  take the money twice.
- **M5 — the saga itself.** A persisted state machine, compensating handlers,
  and a real reservations table carrying `order_id` and `expires_at` so a
  reservation is linked to its order and expires on its own if the saga stalls.

## Consequences

- Checkout stops being synchronous. `POST /orders` returns `PENDING`, and the
  client polls or subscribes for the outcome. The storefront must show pending
  state rather than a completed order.
- The system becomes eventually consistent. There are moments where stock is
  reserved and payment is not yet taken, and that is correct rather than a bug.
- More moving parts: outbox tables, a relay, processed-event tables, saga state.
  That is the cost of correctness across services, and it is the reason people
  warn against splitting services before the domain requires it.

## Reproducing this

The M2 code is preserved in git history. The failure can be reproduced with the
stack running:

```bash
docker compose stop payments-service
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"<id>","qty":5}]}'
curl http://localhost:3000/api/v1/inventory/stock/<id>
```

The payments stub also accepts `PAYMENTS_ALWAYS_DECLINE=true`, which produces
the same orphaned reservation via a declined charge rather than an unreachable
service — the business failure rather than the infrastructure one.

## Related

- ADR-0001 — new repository, reusing infrastructure
- ADR-0003 will record the orchestration-versus-choreography decision in detail (M5)
