# ADR-0003 — Orchestration over choreography for the checkout saga

**Date:** 2026-09-01
**Status:** Accepted
**Milestone:** M5

## Context

ADR-0002 established that checkout needs a saga. It did not settle how the
steps are coordinated. There are two ways.

**Choreography.** No coordinator. Each service reacts to events and emits its
own. Inventory hears `order.created` and reserves; payments hears
`inventory.reserved` and charges; inventory hears `payment.declined` and
releases. The flow is an emergent property of who subscribes to what.

**Orchestration.** One service owns the sequence and sends commands. Here that
is `orders-service`: it holds a persisted state machine, sends
`inventory.commit_requested`, waits for `inventory.committed`, and decides what
happens next.

## Decision

Orchestration, with the state machine in `OrderSagaService` and its state in the
`order_saga` table.

## Rationale

**The flow is readable in one file.** With choreography, answering "what happens
when a card is declined?" means finding every subscriber of `payment.declined`
across several repositories and reconstructing the order in your head. Here the
whole sequence — forward path and both compensation paths — is a hundred lines
in one class, and the recovery policy is a literal table.

**Stuck sagas are visible.** `order_saga.current_step` says exactly what each
order is waiting for. In a choreographed system that state is implicit in which
messages have and have not been sent; there is no row to look at.

**Recovery has somewhere to live.** Resume works because one component knows
what was asked for and never answered. Distributed across four services, each
would have to infer the global state from its own local slice.

**It was the right size for a first implementation.** Choreography is more
decoupled and genuinely more elegant, and it is the better fit once flows are
stable and teams own services independently. But its failure mode is a system
nobody can trace, and that is a poor place to learn from.

## What this costs

- `orders-service` knows the shape of checkout. Adding a shipping step means
  changing it, whereas choreography would let shipping simply subscribe.
- It is a coordination point. If it is down, in-flight sagas stall — though they
  do not corrupt, and reservation expiry still returns the stock.
- It is chattier: a command and a reply where choreography has one event.

These are accepted. The alternative trades traceability for decoupling, and at
this stage traceability is worth more.

## How correctness is maintained

Four mechanisms, each covering a different failure:

1. **Transactional outbox** — the state change and the next command commit
   together, so the saga can never be in a state with no queued work.
2. **`processed_events`** — the same event cannot be handled twice by the same
   consumer.
3. **Step guard** — every transition refuses to fire unless the saga is on the
   step it expects, so a redelivered reply carrying a *new* event id is still a
   no-op.
4. **Reservation expiry** — the backstop under all of it. Whatever else fails,
   held stock returns after 15 minutes.

The fourth matters most. The first three handle failures the system can see;
the fourth handles the ones it cannot — a process that never comes back, a
message an operator drops, a bug not yet found.

## Evidence

Verified against the live stack with real Stripe test-mode payments.

| Scenario | Result |
|---|---|
| Happy path | 50 → 47 available, **0 reserved**; units left exactly once |
| Payment declined | 47 → 42 held, then **back to 47/0 automatically in 6s** |
| Insufficient stock | Cancelled, stock untouched, **payment never attempted** (404) |
| Duplicate delivery | 8 `order.created` events republished; stock unchanged |
| **Orchestrator SIGKILLed mid-saga** | Paid while dead; on restart the saga completed to `confirmed`, 43/0 |
| Reservation expiry | Never paid; hold lapsed, stock returned, row marked `expired` |

The second row is the one ADR-0002 was written about. In M2 that stock stayed
orphaned permanently and needed manual SQL.

The fifth is the strongest: the coordinator was killed with `SIGKILL` — no
graceful shutdown — the customer paid while it was dead, and the order still
completed correctly with the stock deducted exactly once.

## Related

- ADR-0002 — the evidence that a saga was necessary
- A choreographed variant of the same flow would be a worthwhile follow-up
  exercise, precisely because the orchestrated version exists to compare it to.
