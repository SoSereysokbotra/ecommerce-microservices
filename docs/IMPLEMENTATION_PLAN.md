# Implementation Plan — Order–Inventory–Payment Microservices

**Companion to:** `PROJECT_PLAN.md` (scope, releases, risks)
**Created:** 2026-08-31
**Audience:** the developer doing the work

`PROJECT_PLAN.md` says *what* and *why*. This document says *how*, in build order.

---

## 0. How to use this document

### Detail decays with distance

Detail written today for work happening in month nine will be wrong by the time
you get there. So this plan is deliberately uneven:

| Release | Planned to | Why |
|---|---|---|
| **R1** | Task level — concrete files, endpoints, tests | Starts now; decisions are real |
| **R2** | Deliverable level | Shape is clear, details will shift |
| **R3–R5** | Outline level | Re-plan each release when R2 ends |

**Re-plan the next release at the end of the previous one.** Do not try to fill in
R4's task list today.

### Working rhythm

- One milestone = one branch = one PR. Never a long-lived branch.
- A milestone is not done until its Definition of Done passes on CI, not locally.
- Write the ADR *before* the code when a decision is involved, not after.
- If a milestone takes more than 1.5× its estimate, stop and re-scope it rather
  than pushing through.

---

## 1. Conventions

These apply to every service. Define them once in M0; never re-invent them.

### 1.1 Service anatomy

Every service is the same shape. Copy this structure:

```
apps/<name>-service/
  src/
    main.ts                  bootstrap, global prefix /api/v1, pipes, filters
    app.module.ts
    health.controller.ts     GET /health (liveness), GET /ready (readiness)
    config/
      typeorm.config.ts      copied pattern, per-service DATABASE_URL
      env.validation.ts      fail fast on missing secrets
    database/migrations/
    modules/
      <domain>/
        <domain>.controller.ts
        <domain>.service.ts
        <domain>.repository.ts
        <domain>.entity.ts
        dto/
    events/
      outbox.entity.ts       services that publish
      outbox.relay.ts
      processed-event.entity.ts   services that consume
      handlers/
  test/
  Dockerfile
  .env.example
```

### 1.2 Event envelope

Every message on the bus uses this envelope. No exceptions.

```ts
interface DomainEvent<T = unknown> {
  eventId: string;        // uuid — the idempotency key for consumers
  eventType: string;      // 'order.created'
  occurredAt: string;     // ISO 8601
  aggregateId: string;    // the order id, product id, ...
  correlationId: string;  // follows one user action across all services
  version: number;        // schema version, starts at 1
  payload: T;
}
```

**Naming:** `<aggregate>.<past-tense-verb>` — `order.created`, `inventory.reserved`,
`inventory.reservation_failed`, `payment.authorized`, `payment.declined`.

Events are facts about the past. Never name one as a command (`reserve_inventory`)
unless it genuinely is a command sent to a specific service.

### 1.3 The outbox (shared pattern)

The single most important piece of code in the project.

```ts
// Inside a transaction, always. Never publish directly to the broker.
await dataSource.transaction(async (manager) => {
  const order = await manager.save(Order, { ...input, status: 'PENDING' });

  await manager.save(OutboxEvent, {
    eventId: randomUUID(),
    eventType: 'order.created',
    aggregateId: order.id,
    correlationId: ctx.correlationId,
    version: 1,
    payload: { orderId: order.id, items, totalMinor: order.totalMinor },
    publishedAt: null,
  });
});
```

The relay is a separate loop:

```ts
// Runs every ~1s. SKIP LOCKED lets multiple instances run safely.
const batch = await manager.query(`
  SELECT * FROM outbox WHERE published_at IS NULL
  ORDER BY created_at LIMIT 50
  FOR UPDATE SKIP LOCKED
`);

for (const row of batch) {
  await broker.publish(row.event_type, toEnvelope(row));
  await manager.update(OutboxEvent, row.id, { publishedAt: new Date() });
}
```

If the broker is down, rows simply stay unpublished and are retried. **Nothing is
lost.** That is the entire point.

### 1.4 The idempotent consumer (shared pattern)

```ts
async function handleOnce(event: DomainEvent, consumer: string, fn: () => Promise<void>) {
  await dataSource.transaction(async (manager) => {
    try {
      await manager.insert(ProcessedEvent, {
        eventId: event.eventId, consumer, processedAt: new Date(),
      });
    } catch (e) {
      if (isUniqueViolation(e)) return;   // already handled — no-op
      throw e;
    }
    await fn();   // business effect, same transaction as the marker
  });
}
```

The marker and the effect **must** share a transaction. Otherwise a crash between
them either double-applies or silently drops the work.

### 1.5 API conventions

- Base path `/api/v1`
- Lists are paginated: `?limit=&cursor=` returning `{ data, nextCursor }`
- One error shape everywhere:
  `{ statusCode, error, message, correlationId, timestamp, path }`
- Money is always `{ amountMinor: number, currency: string }` — never a float
- Every request carries `x-correlation-id`; the gateway generates one if absent

### 1.6 Definition of Done (every milestone)

1. Feature works via the gateway, not only against the service directly
2. Migrations written and reversible (`down` implemented)
3. Unit tests for business logic; integration tests for anything crossing a service
4. Swagger updated; storefront types regenerated
5. CI green
6. `/health` and `/ready` still correct
7. ADR written if a decision was made

---

## 2. Release 1 — Core commerce and the saga

**Planned to task level. This is the work that starts now.**

---

### M0 — Skeleton

**Goal:** a new repo that boots with the copied parts working and nothing new.

**Tasks**

1. Create `ecommerce-microservices` repo and the folder structure from `PROJECT_PLAN.md` §5
2. Copy `libs/common`, `libs/rabbitmq`, `libs/shared-types`; strip project/task types
3. Copy `api-gateway`; **delete the 55 empty placeholder files**; rewrite
   `services.config.ts` for the new service list
4. Add to the gateway: request timeout, retry with jitter, `x-correlation-id`
   generation — the three things it is missing today
5. Copy `users-service` unchanged; add `/health` and `/ready`
6. Add `env.validation.ts` to both: **throw on missing `JWT_SECRET`**, no `change-me` fallback
7. Write `docker-compose.yml`: rabbitmq, redis, gateway, users — with health checks
   on all four and `depends_on: condition: service_healthy`
8. Create the `users_db` database on Neon; run migrations
9. Fix CI: add `--passWithNoTests`, run lint + build + test
10. Write `docs/adr/0001-new-repo-and-reuse.md`

**Definition of Done**
- `docker compose up -d` brings up a healthy stack from cold
- Register and login work **through the gateway** on `/api/v1/auth/*`
- CI green on a PR
- Stopping RabbitMQ does not prevent the gateway from starting

---

### M1 — Catalog and Inventory

**Goal:** the two simplest services. Plain CRUD, no events yet.

**catalog-service (3002)**

Entities:
```
Product   id, sku UNIQUE, slug UNIQUE, name, description,
          price_minor, currency, category_id, active, created_at, updated_at
Category  id, slug UNIQUE, name, parent_id
```

Endpoints:
```
GET    /api/v1/catalog/products?category=&active=&limit=&cursor=
GET    /api/v1/catalog/products/:idOrSlug
POST   /api/v1/catalog/products
PATCH  /api/v1/catalog/products/:id
GET    /api/v1/catalog/categories
```

Tasks: entities → migrations → repository → service → controller → Swagger →
seed script with ~12 real products across 3 categories.

**inventory-service (3003)**

Entities:
```
Stock  product_id PK, available_qty, reserved_qty, version
```

Endpoints:
```
GET  /api/v1/inventory/stock?productIds=a,b,c
POST /api/v1/inventory/stock/:productId/adjust   { delta, reason }
```

**Generated types**

11. Add `openapi-typescript` and an `npm run gen:api` script
12. Add a CI step that regenerates and **fails if the output differs** — this is
    what prevents the drift that broke the old project

**Definition of Done**
- Products and stock readable through the gateway and in Swagger
- Seed script is idempotent (safe to re-run)
- `gen:api` produces types; CI fails when they are stale

---

### M2 — Orders, deliberately naive

**Goal:** build the wrong version on purpose so the saga is justified, not assumed.

> This code is **thrown away in M3.** Do not polish it.

Entities:
```
Order       id, customer_id, status, currency, subtotal_minor, total_minor, version
OrderItem   id, order_id, product_id, qty, unit_price_minor
```

**Tasks**

1. `POST /api/v1/orders` — validate items, price them from catalog over HTTP
2. Call inventory **synchronously over HTTP** to reserve stock
3. Call a stub payments endpoint **synchronously over HTTP** (always succeeds for now)
4. Set order `CONFIRMED`, return it
5. `GET /api/v1/orders/:id`, `GET /api/v1/orders`

**The experiment (this is the deliverable)**

6. Stop `payments-service`
7. Place an order
8. Observe: stock is reserved, the order is stuck, nothing recovers it
9. Record it in `docs/adr/0002-why-a-saga.md` — with the actual DB rows and log
   output pasted in, not a description

**Definition of Done**
- ADR-0002 exists and contains **real evidence** of the broken state
- You can explain out loud why a database transaction cannot fix this

---

### M3 — Outbox and events

**Goal:** replace synchronous calls with reliable messaging.

**Tasks**

1. `outbox` migration in orders-service and inventory-service
2. Implement `OutboxService.append(manager, event)` per §1.3
3. Implement `OutboxRelay` with `FOR UPDATE SKIP LOCKED`, 1s interval
4. `processed_events` migration in both services
5. Implement `handleOnce()` per §1.4 in `libs/common`
6. Rewrite order placement:
   - orders writes `Order(PENDING)` + `order.created` in one transaction
   - inventory consumes `order.created` → reserves → emits `inventory.reserved`
     or `inventory.reservation_failed`
   - orders consumes the reply → updates status
7. **Delete all synchronous service-to-service HTTP calls**
8. Propagate `correlationId` through the envelope into every log line

**Tests**

9. Broker-outage test: stop RabbitMQ → place order → restart → event still delivered
10. Duplicate-delivery test: publish the same `eventId` twice → exactly one effect
11. Relay concurrency test: two relay instances → no double publish

**Definition of Done**
- No service calls another over HTTP for order placement
- Both tests above pass in CI against real Postgres and RabbitMQ (Testcontainers)

---

### M4 — Stripe payments

**Goal:** real payment provider, in test mode, with webhooks handled correctly.

Entities:
```
Payment        id, order_id, idempotency_key UNIQUE, provider, provider_ref,
               amount_minor, currency, status
WebhookEvent   provider_event_id UNIQUE, type, payload, processed_at
Refund         id, payment_id, amount_minor, reason, provider_ref, status
```

**Tasks**

1. Add the Stripe SDK; put keys in `.env`, validated at boot
2. `POST /api/v1/payments/intents` — create a PaymentIntent using
   **`idempotency_key = orderId + attempt`**, persist the row, return the client secret
3. `POST /api/v1/payments/webhook`:
   - **public route** (no JWT — Stripe cannot authenticate)
   - **raw body parser** on this route only, or signature verification fails
   - `stripe.webhooks.constructEvent()` to verify the signature
   - insert `provider_event_id` → unique violation means already processed, return 200
   - map to `payment.authorized` / `payment.declined`, write to outbox
4. `POST /api/v1/payments/:id/refund` — also idempotent
5. Install the Stripe CLI; document `stripe listen --forward-to` in the README

**Tests**

6. Successful test-mode payment produces `payment.authorized` exactly once
7. Replaying the same webhook twice is a no-op
8. An invalid signature is rejected with 400
9. A declined test card produces `payment.declined`

**Definition of Done**
- A payment completes end to end through Stripe test mode
- Webhook replay changes nothing
- No card data ever reaches our servers (hosted Checkout only)

---

### M5 — The saga

**Goal:** the milestone this project exists for.

Entity:
```
OrderSaga  order_id PK, current_step, status, compensating, last_error,
           attempts, updated_at
```

**Tasks**

1. Define the state machine explicitly, in one file, as data:

```
CREATED        → reserve_inventory
RESERVED       → create_payment
AWAITING_PAY   → (webhook) → confirm
PAID           → commit_reservation → CONFIRMED

FAILED_STOCK   → cancel
FAILED_PAYMENT → release_inventory → cancel
FAILED_AFTER_PAYMENT → refund → release_inventory → cancel
```

2. One handler per step; each is idempotent and records its own transition
3. Compensation handlers: `release_inventory`, `refund_payment`, `release_coupon` (stub until R2)
4. Reservation expiry job in inventory-service — releases `HELD` reservations past
   `expires_at`, emits `inventory.reservation_expired`
5. **Saga resume on startup:** scan for sagas not in a terminal state and re-drive them
6. A test-only endpoint or config flag to force a payment decline

**Tests (all required)**

7. Happy path → `CONFIRMED`, stock decremented once
8. Payment declined → stock returns to original level, order `CANCELLED`
9. Insufficient stock → order `CANCELLED`, payment never attempted
10. Duplicate `inventory.reserved` → single effect
11. **Kill orders-service mid-saga, restart → saga resumes and completes**
12. Reservation expiry releases a stalled hold

**Definition of Done**
- Test 8 demonstrable on demand: force a decline, watch stock return automatically
- Test 11 passes — this is the one that proves you understand saga state

---

### M6 — Storefront v1

**Goal:** something a stranger can use.

**Tasks**

1. Copy the Next.js shell; wire the generated API types
2. Pages: `/` (product grid), `/products/[slug]`, `/checkout`, `/orders/[id]`
3. Checkout redirects to **Stripe Checkout** (hosted — keeps PCI at SAQ-A)
4. Order status page polls until terminal; shows cancellation reason when cancelled
5. Auth pages reusing users-service
6. Playwright E2E: register → browse → order → confirmed
7. Deploy to Railway or Fly.io; document the deployment

**Definition of Done**
- A stranger can place a test-mode order end to end on a public URL
- The failure case can be demonstrated live in the UI

> **R1 complete.** This is already a strong portfolio project. Re-plan R2 now.

---

## 3. Release 2 — Real checkout

**Planned to deliverable level. Re-plan to task level when R1 ends.**

### M7 — Cart
cart-service; Redis-backed guest carts keyed by cookie; Postgres carts for logged-in
users; **merge on login** (the interesting part); abandonment job.
*Watch for:* merge conflicts when the same product exists in both carts.

### M8 — Tax and discounts
pricing-service; `tax_rates` by country/region/category; percentage and fixed
discounts; a single `POST /pricing/quote` that orders calls to price a basket.
*Watch for:* rounding. Round once, at the end. Test totals across three regions.

### M9 — Coupons
Coupon codes with usage limits and validity windows; **optimistic locking on
`coupons.version`**; `coupon_redemptions.order_id` unique; redemption released when
a saga compensates.
*Acceptance:* 50 parallel redemptions of a 10-use coupon yield exactly 10.
*This is the concurrency milestone — do not skip the load test.*

### M10 — Shipping
shipping-service; customer addresses; rate calculation by weight/zone; shipment
lifecycle `PENDING → DISPATCHED → DELIVERED`; consumes `order.paid`.

### M11 — Multi-currency
Minor units audited everywhere; `fx_rates` table with scheduled refresh; **the rate
used is frozen onto the order at purchase time**; storefront currency switcher.
*Watch for:* historical orders must never re-price when rates change.

---

## 4. Release 3 — Discovery and trust

**Outline only.**

- **M12 Search** — OpenSearch index built **from catalog events**, never by reading
  catalog's database. This is the CQRS milestone. Include a reindex-from-scratch command.
- **M13 Reviews** — reviews-service; verified-purchase flag derived from order
  events; moderation queue; rating rollup projected onto the search index.
- **M14 Recommendations** — co-purchase pairs computed from `order.paid` events.
- **M15 Notifications** — notifications-service consuming domain events; order
  confirmation, shipment, refund emails; idempotent so no duplicate sends.

---

## 5. Release 4 — Operations and hardening

**Outline only.**

- **M16 Authorisation** — real RBAC; every query scoped to the caller; implement the
  roles guard properly. *Do this before the admin UI exists, not after.*
- **M17 Admin dashboard** — separate Next.js app; products, stock, orders, refunds,
  coupons, review moderation.
- **M18 Resilience** — gateway circuit breaker; DLQ with exponential backoff;
  poison-message quarantine.
- **M19 Observability** — OpenTelemetry into Jaeger; Prometheus + Grafana; alerts on
  error rate, latency, and **outbox lag** (the metric that matters most here).

---

## 6. Release 5 — Scale and reach

**Outline only.**

- **M20 i18n** — localised product content tables; locale routing; translated UI.
- **M21 Kubernetes** — Helm charts; liveness/readiness probes wired to the existing
  endpoints; secrets; HPA; ingress; local `kind` cluster first.
- **M22 Deploy and load test** — managed cluster; CI-driven deploys; k6 load test;
  document capacity limits and where it breaks.

---

## 7. First week — start here

If nothing else, do this:

1. Create the repo and folder structure
2. Copy `libs/` and get `users-service` booting alone
3. Copy the gateway, delete the 55 empty files, route to users only
4. `docker compose up -d` → register and login work
5. CI green
6. Commit `ADR-0001`

That is M0. It is deliberately small so that the project starts rather than being
planned forever.

---

## Appendix A — Testing strategy

| Level | Tool | What it covers | When |
|---|---|---|---|
| Unit | Jest | Pure business logic, saga transitions, pricing | From M1 |
| Integration | Jest + Testcontainers | Real Postgres and RabbitMQ; outbox, idempotency | From M3 |
| Contract | Pact or generated-type check | Gateway ↔ service shapes | From M1 (type check) |
| E2E | Playwright | Register → order → confirmed | From M6 |
| Load | k6 | Coupon concurrency, checkout throughput | M9, M22 |

**Rule:** anything that crosses a service boundary gets an integration test, not a
mock. Mocks would have hidden every bug that mattered in the old project.

---

## Appendix B — Local development

```bash
docker compose up -d              # full stack
docker compose up -d rabbitmq redis   # infra only, run services on host
stripe listen --forward-to localhost:3005/api/v1/payments/webhook
npm run gen:api                   # regenerate storefront types
npm run migration:run -w apps/orders-service
```

**Ports:** gateway 3000 · users 3001 · catalog 3002 · inventory 3003 · orders 3004 ·
payments 3005 · cart 3006 · pricing 3007 · shipping 3008 · search 3009 ·
reviews 3010 · notifications 3011 · storefront 3100 · admin 3101

---

## Appendix C — Architecture decision records

Write one whenever a choice has a defensible alternative. Keep them short.

| ADR | Decision | Milestone |
|---|---|---|
| 0001 | New repo, reuse infrastructure from `saas-business-platform` | M0 |
| 0002 | Why synchronous orchestration fails — evidence for the saga | M2 |
| 0003 | Orchestration over choreography | M5 |
| 0004 | Stripe hosted Checkout over custom card form (PCI SAQ-A) | M4 |
| 0005 | OpenSearch over Postgres full-text | M12 |
| 0006 | Service boundaries — what was deliberately *not* split | M0 |
