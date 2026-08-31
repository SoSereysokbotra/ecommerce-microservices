# Order–Inventory–Payment Microservices — Project Plan

**Owner:** So Sereysokbotra
**Status:** Planning
**Created:** 2026-08-31
**Revised:** 2026-08-31 — scope expanded to a full commerce platform
**Repo:** `ecommerce-microservices` (new, to be created)

---

## 1. Why this project exists

This is a **learning project with a portfolio outcome**, built as a full commerce
platform. The technical centre of gravity is the part a task-tracker cannot teach:
**business operations that span multiple services and multiple databases, and must
stay consistent when one of them fails.**

Reserving stock, charging a card, and releasing the stock when the charge fails
cannot be done with a single database transaction. Everything else in this plan is
built around getting that right and then growing a real product on top of it.

### Learning objectives

| Objective | Proven in |
|---|---|
| Saga pattern with compensating transactions | R1 |
| Transactional outbox — events are never silently lost | R1 |
| Idempotent consumers, idempotent payments, idempotent webhooks | R1 |
| Eventual consistency and at-least-once delivery | R1 |
| Third-party integration with asynchronous callbacks (Stripe webhooks) | R1 |
| Concurrency control under contention (coupon redemption, stock) | R2 |
| Money handling: minor units, rounding, multi-currency | R2 |
| CQRS read models built from events (search index) | R3 |
| Role-based authorisation and back-office separation | R4 |
| Resilience: retries, backoff, DLQ, circuit breaker | R4 |
| Distributed tracing and correlated logs | R4 |
| Container orchestration: Kubernetes, probes, autoscaling | R5 |
| Internationalisation and localised content modelling | R5 |

---

## 2. Scope

### In scope

**Core commerce**
- Product catalog, categories, stock levels and reservations
- Cart, checkout, order lifecycle
- Order saga with compensation across inventory and payments

**Payments (real)**
- Stripe integration with real money movement
- PaymentIntents, webhook handling, refunds
- PCI compliance via hosted card capture (see §3)

**Commerce depth**
- Shipping: addresses, rates, shipment lifecycle
- Tax calculation
- Discounts and coupon codes
- Wishlists

**Discovery and trust**
- Product search
- Product reviews and ratings
- Recommendations ("customers also bought")

**Operations**
- Admin dashboard / back-office UI
- Multi-currency
- Internationalisation (i18n) of storefront and product content
- Kubernetes deployment

### Out of scope

- **Mobile app** — the storefront is responsive web only.

### Not planned (revisit only after R5)

Adjacent temptations that are not in any release. Adding one requires a written
decision and a milestone of its own.

- Multi-vendor marketplace (multiple sellers)
- Subscriptions / recurring billing
- Warehouse management (picking, packing, bin locations)
- Loyalty points, gift cards, store credit
- Live chat / support ticketing

---

## 3. Two constraints that shape everything

### PCI: never let card data touch your servers

Real money is in scope, so this is not optional.

Use **Stripe Checkout or Stripe Elements**, where the card number is captured by
Stripe's iframe and never reaches `payments-service`. This keeps the project in
**PCI SAQ-A**, the lightest compliance tier — a self-assessment questionnaire, not
an audit. Your server only ever sees a token and a PaymentIntent ID.

**Never** build a card input form that posts to your own API. That moves you to
SAQ-D, which is a serious compliance burden and is not appropriate for this project.

### Real money has non-technical blockers

Going live (not test mode) requires things code cannot supply:

- A registered business entity or sole-trader registration Stripe will accept
- A bank account in a Stripe-supported country
- Published terms of service, refund policy, and privacy policy
- Tax registration if selling to real customers

**Plan:** build and demonstrate everything in **Stripe test mode**. Switch to live
mode only if and when the above are actually in place. Test mode exercises every
code path including webhooks, refunds and failures — the code does not change.

---

## 4. Approach: reuse, don't rebuild

Substantial infrastructure already exists in `saas-business-platform`. Rebuilding
it teaches nothing new and would consume weeks.

| Component | Decision | Notes |
|---|---|---|
| `libs/common`, `libs/rabbitmq`, `libs/shared-types` | **Copy** | Adapt types to the new domain |
| `api-gateway` | **Copy** | Repoint to new services; add the missing timeouts + retries |
| `users-service` | **Copy** | Auth is domain-agnostic; extend with addresses and wishlists |
| `docker-compose.yml`, Dockerfiles | **Copy** | Edit service names and ports |
| TypeORM config + migration setup | **Copy** | Same pattern per service |
| `.github/workflows/ci.yml` | **Copy and fix** | Current version fails: it runs tests for services that have none |
| Next.js shell | **Copy** | Layout, auth, API client — but generate types from OpenAPI this time |
| All new domain services | **Write new** | This is the actual work |

**Defects not to carry over:** the 55 empty placeholder files in the gateway,
hand-mirrored frontend types, missing health endpoints, and the `?? 'change-me'`
JWT secret fallback.

---

## 5. Architecture

### Services

| Service | Port | Owns | Release |
|---|---:|---|---|
| api-gateway | 3000 | Routing, JWT, rate limiting | R1 (copied) |
| users-service | 3001 | Auth, customers, addresses, wishlists | R1 (copied) |
| catalog-service | 3002 | Products, categories, localised content | R1 |
| inventory-service | 3003 | Stock, reservations, expiry | R1 |
| orders-service | 3004 | Order lifecycle, **saga orchestrator** | R1 |
| payments-service | 3005 | Stripe, webhooks, refunds, idempotency | R1 |
| cart-service | 3006 | Carts, guest carts, cart merge on login | R2 |
| pricing-service | 3007 | Tax, discounts, coupons, currency conversion | R2 |
| shipping-service | 3008 | Rates, shipments, tracking | R2 |
| search-service | 3009 | Search index (read model), recommendations | R3 |
| reviews-service | 3010 | Reviews, ratings, moderation | R3 |
| notifications-service | 3011 | Email/event consumer | R3 |
| storefront (Next.js) | 3100 | Customer UI | R1 |
| admin (Next.js) | 3101 | Back-office UI | R4 |

Supporting: RabbitMQ, Redis, one Postgres database per service, OpenSearch (R3).

### A deliberate note on service count

Twelve services is a lot for one developer, and every split costs a database, a
deployment, a health check and a failure mode. The splits above are justified by
either a distinct data lifecycle or a distinct scaling profile.

**Deliberately not split:** wishlists live in users-service, recommendations live
in search-service, and tax/discounts/coupons/currency all live in pricing-service.
Resist splitting further — a distributed monolith is worse than a monolith.

### Repository layout

```
ecommerce-microservices/
  apps/
    api-gateway/  users-service/  catalog-service/  inventory-service/
    orders-service/  payments-service/  cart-service/  pricing-service/
    shipping-service/  search-service/  reviews-service/  notifications-service/
  libs/
    common/  rabbitmq/  shared-types/
  storefront/
  admin/
  deploy/
    compose/          <- local development
    k8s/              <- Helm charts (R5)
  docs/
    adr/              <- architecture decision records
```

### Tech stack

NestJS · TypeScript · PostgreSQL (Neon) · TypeORM · RabbitMQ · Redis ·
Stripe · OpenSearch · Next.js · Docker Compose · Kubernetes + Helm · GitHub Actions

---

## 6. Domain model

Only the tables that carry a pattern are listed.

### orders-service
```
orders            id, customer_id, status, currency, subtotal_minor, tax_minor,
                  shipping_minor, discount_minor, total_minor, version
order_items       id, order_id, product_id, qty, unit_price_minor
order_saga        order_id, current_step, status, compensating, last_error
outbox            id, aggregate_id, event_type, payload, created_at, published_at
processed_events  event_id, consumer, processed_at
```
`orders.status`: `PENDING → AWAITING_PAYMENT → PAID → FULFILLED` / `CANCELLED` / `REFUNDED`

### inventory-service
```
stock             product_id, available_qty, reserved_qty, version
reservations      id, order_id, product_id, qty, status, expires_at
```
`reservations.status`: `HELD → COMMITTED` / `RELEASED` / `EXPIRED`

### payments-service
```
payments          id, order_id, idempotency_key UNIQUE, provider, provider_ref,
                  amount_minor, currency, status
webhook_events    provider_event_id UNIQUE, type, payload, processed_at
refunds           id, payment_id, amount_minor, reason, provider_ref, status
```

### pricing-service
```
tax_rates         id, country, region, category, rate_bps
coupons           code UNIQUE, type, value, max_redemptions, redeemed_count,
                  starts_at, ends_at, version
coupon_redemptions id, coupon_code, order_id UNIQUE, customer_id, redeemed_at
fx_rates          base_currency, quote_currency, rate, fetched_at
```

### Money rules (non-negotiable)

- Store money as **integer minor units** (`total_minor`), never floating point
- Every amount carries an explicit **currency code**
- Round once, at the last step, and record the rounding
- Orders store the **FX rate used at purchase time**, not a live lookup

### The five constraints the design rests on

1. `outbox` written in the **same transaction** as the business row → events cannot be lost
2. `processed_events` primary key → redelivery cannot double-apply
3. `payments.idempotency_key` unique → a retry cannot double-charge
4. `webhook_events.provider_event_id` unique → Stripe's repeated webhooks are safe
5. `coupon_redemptions.order_id` unique + optimistic locking on `coupons.version`
   → a coupon cannot be over-redeemed under concurrency

---

## 7. Core flow: the order saga

**Pattern:** orchestration. `orders-service` owns an explicit state machine, chosen
over choreography because the flow stays visible and debuggable.

### Happy path

| Step | Actor | Action |
|---:|---|---|
| 1 | orders | Write order `PENDING` + outbox event, one transaction |
| 2 | pricing | Calculate tax, apply coupon, reserve redemption |
| 3 | inventory | Reserve stock, create reservation with `expires_at` |
| 4 | payments | Create Stripe PaymentIntent with idempotency key |
| 5 | *customer* | Completes payment in Stripe's hosted form |
| 6 | payments | Receives `payment_intent.succeeded` **webhook** |
| 7 | orders | Order → `PAID` |
| 8 | inventory | Commit reservation, decrement real stock |
| 9 | shipping | Create shipment |

Step 5–6 is why this must be a saga and not a function call: **the confirmation
arrives asynchronously, from outside your system, possibly twice, possibly minutes
later, possibly never.**

### Failure paths

| Trigger | Compensation |
|---|---|
| Insufficient stock (step 3) | Release coupon redemption → order `CANCELLED`; payment never attempted |
| Payment declined / abandoned (step 6 never arrives) | Release stock reservation → release coupon → order `CANCELLED` |
| Fulfilment fails after payment | **Refund via Stripe** → release stock → order `REFUNDED` |

The third row is the one that involves real money moving back. It is the strongest
demonstration in the whole project.

### Reservation and cart expiry

Scheduled jobs release reservations past `expires_at` and abandon stale carts.
Without them a stalled saga leaks stock permanently. Required, not optional.

---

## 8. Releases

Five sequential releases. **Each one ends with a working, demonstrable system.**
This is deliberate: if the project stops early, the result is a complete smaller
product rather than twelve half-finished services.

Estimates assume one part-time student developer and are planning aids, not
commitments.

---

### R1 — Core commerce and the saga (≈ 10–14 weeks)

*The foundation. Everything else builds on this.*

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| M0 | Skeleton | New repo; libs, gateway, users-service copied and running; `/health` on every service + Compose health checks; CI green | `docker compose up -d` boots; register/login works through the gateway |
| M1 | Catalog + Inventory | Products CRUD, categories, seed data; stock table and adjustments; types generated from OpenAPI | Products and stock readable via API and Swagger |
| M2 | Orders, naive | Order creation calling inventory and payments **synchronously over HTTP**; ADR recording what breaks | Kill payments mid-request and **document** the stuck reservation |
| M3 | Outbox + events | Outbox table and relay in orders/inventory; `processed_events` in every consumer; sync calls removed | Stop RabbitMQ, place order, restart — event still delivered; double delivery changes nothing |
| M4 | Stripe payments | PaymentIntents with idempotency keys; **webhook receiver with signature verification and dedupe**; refunds | Payment completes via Stripe test mode; replaying a webhook twice is a no-op |
| M5 | The saga | `order_saga` state machine; compensation on decline; reservation expiry job; refund-on-fulfilment-failure | Forced decline returns stock automatically; killing orders-service mid-saga resumes correctly |
| M6 | Storefront v1 | Product list, detail, checkout, order status | A stranger can place a test-mode order end to end |

> **M2 is deliberately throwaway.** Building the wrong version first is what makes
> the saga justifiable rather than cargo-culted. Do not skip it.

**R1 exit:** a working shop with a correct saga. This alone is a strong portfolio
project.

---

### R2 — Real checkout (≈ 8–10 weeks)

*Turns a demo into something resembling a real store.*

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| M7 | Cart | cart-service; guest carts in Redis; merge on login; abandonment job | Guest can build a cart, log in, and keep it |
| M8 | Pricing: tax + discounts | pricing-service; tax rates by region; percentage/fixed discounts | Order totals correct across three tax regions |
| M9 | Coupons | Coupon codes with limits and windows; optimistic locking; redemption released on cancellation | **Concurrency test:** 50 parallel redemptions of a 10-use coupon yield exactly 10 |
| M10 | Shipping | shipping-service; addresses; rate calculation; shipment lifecycle and tracking | Shipping cost in total; shipment created on payment |
| M11 | Multi-currency | Minor units everywhere; FX rates; rate frozen at purchase | Same product priced in 3 currencies; historical orders keep their original rate |

**R2 exit:** a store a real customer could plausibly use.

---

### R3 — Discovery and trust (≈ 6–8 weeks)

*Read models and event-driven projections — the CQRS lesson.*

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| M12 | Search | search-service; OpenSearch index built **from catalog events**, not direct DB reads; faceted filtering | Product edit appears in search within seconds, with no shared database |
| M13 | Reviews | reviews-service; verified-purchase flag from order events; moderation queue; rating rollup | Only customers who bought can review; average rating updates on publish |
| M14 | Recommendations | Co-purchase model built from order events | "Customers also bought" on product pages |
| M15 | Notifications | notifications-service consuming domain events; order confirmation, shipment, refund emails | Every order state change sends the right email exactly once |

**R3 exit:** the storefront feels like a product, not a prototype.

---

### R4 — Operations and hardening (≈ 6–8 weeks)

*The part that makes it operable by someone other than you.*

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| M16 | Authorisation | Real RBAC; every query scoped to the caller; admin/staff/customer roles; empty roles guard implemented | No endpoint returns another customer's data; verified by test |
| M17 | Admin dashboard | admin Next.js app: products, stock, orders, refunds, coupons, review moderation | A non-developer can fulfil and refund an order |
| M18 | Resilience | Gateway timeouts, retry with jitter, circuit breaker; DLQ with backoff | Killing a service degrades gracefully instead of 500-ing |
| M19 | Observability | Structured JSON logs with correlation ID across all services; OpenTelemetry into Jaeger; Prometheus + Grafana; alerts | One order traced end to end by a single ID, as a span waterfall |

**R4 exit:** a system you can operate and debug in production.

---

### R5 — Scale and reach (≈ 6–8 weeks)

| # | Milestone | Deliverables | Acceptance |
|---|---|---|---|
| M20 | i18n | Localised product content; locale routing; translated storefront; locale-aware formatting | Full purchase flow in two languages |
| M21 | Kubernetes | Helm charts; liveness/readiness probes; secrets; HPA; ingress; local kind cluster | Whole stack runs on K8s; a killed pod self-heals |
| M22 | Deploy + load test | Managed cluster deploy; automated from CI; k6 load test; documented capacity limits | Public URL; documented behaviour under load |

**R5 exit:** deployed, scalable, internationalised.

---

## 9. Cross-cutting requirements

Part of "done" for every milestone.

- `/health` (liveness) and `/ready` (readiness) on every service
- Migrations only — never `synchronize: true`
- Service refuses to boot if a required secret is missing
- Every list endpoint paginated
- API versioned under `/api/v1`
- One documented error response shape
- Swagger per service; storefront and admin types generated from it
- Money as integer minor units with explicit currency
- No secrets committed; `.env.example` only
- Every new consumer is idempotent from the first commit

---

## 10. Timeline and the descope ladder

**Total: roughly 36–48 weeks part-time (9–12 months).** This is a large programme,
not a term project.

If time runs short, cut **from the bottom up** — never from R1.

| Cut order | What goes | Cost of cutting |
|---:|---|---|
| 1 | M22 load testing | Lose capacity evidence |
| 2 | M20 i18n | Lose localisation story |
| 3 | M21 Kubernetes → stay on Compose | Lose orchestration story; still deployable |
| 4 | M14 recommendations | Minor; search and reviews carry R3 |
| 5 | M13 reviews | Lose the verified-purchase projection |
| 6 | M11 multi-currency | Keep single currency; minor-unit discipline stays |
| 7 | M10 shipping | Flat shipping rate instead |

**Never cut:** M0–M6 (R1), M9 coupon concurrency, M16 authorisation, M19
observability. Those carry the learning objectives.

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Scope is large enough to stall before R1 ships** | Critical | Releases are sequential and independently shippable; R1 is the priority |
| Stripe live-mode blockers (entity, bank, policies) | High | Build entirely in test mode; live mode is a separate decision, not a dependency |
| PCI mistakes if a card form is ever hand-built | Critical | Hosted Stripe capture only; card data must never reach our servers |
| M5 (saga) harder than estimated | High | R1 holds the most slack; trim R3/R5, never R1 |
| Twelve services overwhelm one developer operationally | High | No further splitting; Compose until R5; shared libs for cross-cutting concerns |
| Free-tier database/broker limits | Medium | Monitor connection counts; consolidate databases before consolidating services |
| Distributed debugging without tooling wastes days | Medium | Pull M19 forward if debugging becomes painful |
| Motivation loss across 9–12 months | High | Each release ships something demonstrable; R1 alone is portfolio-worthy |
| Old repo's defects copied along with its code | Medium | Defect list in §4 reviewed before each copy |

---

## 12. Definition of Done

**Release 1 (minimum viable outcome):**

1. A public URL where a test-mode order can be placed end to end.
2. A payment failure automatically returns stock to its original level, with no manual intervention.
3. Killing any single service mid-order does not corrupt data; the saga completes or compensates once it returns.
4. Delivering the same event or Stripe webhook twice changes nothing.
5. CI is green and genuinely runs tests.

**Full programme:**

6. A non-developer can fulfil and refund an order from the admin dashboard.
7. One correlation ID traces a request across every service as a span waterfall.
8. Fifty concurrent redemptions of a ten-use coupon result in exactly ten.
9. The full purchase flow works in two languages and three currencies.
10. The stack runs on Kubernetes and self-heals a killed pod.
11. The README explains the saga clearly enough for a reviewer who has never seen the code.

---

## 13. Open decisions

| Decision | Needed by | Recommendation |
|---|---|---|
| Orchestration vs choreography | M5 | **Orchestration** — visible state machine, debuggable |
| Stripe test mode vs live | M4 | **Test mode** for the whole build; live only if §3 blockers clear |
| Stripe Checkout vs Elements | M4 | **Checkout** first (fastest to PCI-safe); Elements later for UI control |
| Search engine | M12 | **OpenSearch** — Postgres full-text is simpler but teaches less |
| Tax rates: hand-maintained vs API | M8 | **Hand-maintained table** — a real tax API adds cost, not learning |
| Kubernetes target | M21 | kind locally; managed cluster only when R4 is stable |
| Keep `users-service` name or rename to `customers` | M0 | Cosmetic; decide once and stay consistent |

---

## Appendix — relationship to `saas-business-platform`

That repository is a separate, finished portfolio piece and is **not modified** by
this project. Its outstanding cleanup (dead placeholder files, red CI, missing
authorisation scoping) is tracked separately and does not block this plan.
