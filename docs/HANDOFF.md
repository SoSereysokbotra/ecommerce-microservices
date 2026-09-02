# Handoff — read this first

**Written:** 2026-09-01
**Repo:** https://github.com/SoSereysokbotra/ecommerce-microservices (public, `main`)
**Local:** `d:\Year2\Microservices\Order‑Inventory‑Payment Microservices\ecommerce-microservices`

This document exists so a new session can continue without re-deriving anything.
Read it fully before touching code — several things here were learned the hard
way and will cost hours to rediscover.

---

## 1. What this project is

A learning project with a portfolio outcome. The point is **not** the shop; it is
the one thing a CRUD app cannot teach: a business operation spanning several
services and databases that stays correct when one of them fails.

Reserving stock, charging a card, and putting the stock back when the charge
fails cannot be done in one database transaction. Getting that right — the
saga, the outbox, idempotency, compensation — is the whole project.

**Full scope:** `docs/PROJECT_PLAN.md` (5 releases, 23 milestones, ~9–12 months).
**Build order:** `docs/IMPLEMENTATION_PLAN.md`.
**Decisions:** `docs/adr/`. ADR-0002 is the most important thing in the repo.

There is a second, unrelated repo one level up (`saas-business-platform`). It is
finished and must not be modified. See §9 — it has a live security problem.

---

## 2. Status: 6 of 23 milestones done

| | Milestone | State |
|---|---|---|
| M0 | Skeleton: gateway + users-service | done |
| M1 | catalog-service + inventory-service | done |
| M2 | Orders, deliberately synchronous (thrown away) | done |
| M3 | Transactional outbox + idempotent consumers | done |
| M4 | Stripe payments, webhooks, refunds | done |
| M5 | **The saga** — compensation, expiry, crash recovery | done |
| M6 | Storefront + Playwright + public deployment | done |
| M7–M22 | Releases 2–5 | not started |

**M6 is complete.** Its acceptance criterion — "a stranger can place a test-mode
order end to end on a public URL" — was met on 2026-09-02 via Cloudflare Tunnel,
verified with real Stripe test-mode webhooks over the public URL, including the
declined-card compensation path. See `docs/DEPLOYMENT.md`.

Caveat worth stating plainly: the tunnel serves from **this machine**, so the
site is up only while it is. That satisfies M6 but is not a 24/7 deployment.
Part B of DEPLOYMENT.md is the managed-platform path, blocked on a Railway plan.

**Next task: R2 (M7+), or make the deployment permanent.** See §8.

---

## 3. Architecture

Six backend services plus a Next.js storefront. Every service owns its own Neon
PostgreSQL database. Nothing is reachable from a browser except the gateway.

| Service | Port | Owns |
|---|---:|---|
| api-gateway | 3000 | Routing, JWT, rate limiting, correlation ids, raw-body passthrough for Stripe |
| users-service | 3001 | Auth, customers |
| catalog-service | 3002 | Products, categories |
| inventory-service | 3003 | Stock, reservations, expiry sweep |
| orders-service | 3004 | Orders + **saga orchestrator** |
| payments-service | 3005 | Stripe intents, webhooks, refunds |
| storefront | 3100 | Next.js UI |

Supporting: RabbitMQ (5672 / 15672), Redis (6379, declared but not yet used).

### The saga

`orders-service` owns an explicit state machine in
`apps/orders-service/src/modules/orders/order-saga.service.ts`, persisted in the
`order_saga` table. Orchestration, not choreography — reasons in ADR-0003.

```
Forward:
  POST /orders  ->  order PENDING + order.created  (one transaction)
  inventory     ->  reserves, emits inventory.reserved
  orders        ->  AWAITING_PAYMENT + payment.requested
  payments      ->  creates Stripe PaymentIntent
  customer pays ->  Stripe webhook -> payment.authorized
  orders        ->  inventory.commit_requested
  inventory     ->  commits, emits inventory.committed
  orders        ->  CONFIRMED

Compensation:
  card declined ->  inventory.release_requested -> inventory.released -> CANCELLED
  no stock      ->  CANCELLED immediately, payment never attempted
  after payment ->  payment.refund_requested -> payment.refunded -> release -> CANCELLED
  hold lapses   ->  inventory expiry sweep -> inventory.reservation_expired -> CANCELLED
```

Event names are `<aggregate>.<past-tense>` for facts, `<target>.<verb>_requested`
for commands the orchestrator sends. The distinction is deliberate: the routing
key alone tells you the direction of control.

### The four correctness mechanisms

Each covers a different failure. Do not remove any of them.

1. **Transactional outbox** (`libs/outbox`) — the business change and the next
   event commit together. A broker outage delays events, never loses them.
2. **`processed_events`** — the same event cannot be handled twice by the same
   consumer. Marker and effect share one transaction.
3. **Saga step guard** — a transition refuses unless the saga is on the step it
   expects, so even a republished event with a *new* id is a no-op.
4. **Reservation expiry** — 15-minute holds swept every 30s. The backstop under
   everything else: whatever fails, stock comes back.

Payments has a fifth: the Stripe idempotency key is `order_<orderId>`, derived
from the order rather than the event, so a republished request cannot double
charge.

---

## 4. Running it locally

### Prerequisites

Docker Desktop, Node 20+, a Neon account (5 projects), a Stripe **sandbox**
account, and the Stripe CLI.

### Secrets — none are in git

Every `apps/*/.env` and `storefront/.env.local` is gitignored and **must be
recreated on a new machine**. `.env.example` files show the shape.

| File | Needs |
|---|---|
| `apps/users-service/.env` | `DATABASE_URL` (Neon), `JWT_SECRET` |
| `apps/catalog-service/.env` | `DATABASE_URL`, `JWT_SECRET` |
| `apps/inventory-service/.env` | `DATABASE_URL`, `JWT_SECRET` |
| `apps/orders-service/.env` | `DATABASE_URL`, `JWT_SECRET` |
| `apps/payments-service/.env` | `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET` |
| `apps/api-gateway/.env` | `JWT_SECRET` |
| `storefront/.env.local` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |

`JWT_SECRET` must be **identical** across the gateway and all services.
`scripts/setup.sh` generates one and copies it everywhere.

### Start

```bash
docker compose up -d

# Migrations, once per database
docker compose exec users-service     npm run migration:run --prefix apps/users-service
docker compose exec catalog-service   npm run migration:run --prefix apps/catalog-service
docker compose exec inventory-service npm run migration:run --prefix apps/inventory-service
docker compose exec orders-service    npm run migration:run --prefix apps/orders-service
docker compose exec payments-service  npm run migration:run --prefix apps/payments-service

# Seed, in this order — the inventory seed asks catalog for ids over HTTP
docker compose exec catalog-service   npm run seed --prefix apps/catalog-service
docker compose exec inventory-service npm run seed --prefix apps/inventory-service

# Stripe webhooks (leave running in its own terminal)
stripe listen --api-key sk_test_... --forward-to localhost:3005/api/v1/payments/webhook

# Storefront
cd storefront && npm run dev        # http://localhost:3100
```

### Checks

```bash
npm run lint
npm run test:all                    # 39 unit tests
npm run gen:spec && npm run gen:types
bash scripts/scan-secrets.sh
cd storefront && npm run e2e        # 5 Playwright tests, needs the stack up
```

---

## 5. Gotchas — each of these cost real time

**`stripe listen` mints a NEW signing secret every session.** When you restart
it, copy the new `whsec_...` into `apps/payments-service/.env` and then
`docker compose up -d --force-recreate payments-service`. A plain `restart` does
**not** reload `env_file`, and every webhook silently returns 400.

**Do not grep the Stripe CLI output for the secret without stripping ANSI codes
first.** The CLI colourises it; a naive grep truncates the secret to ~10 chars
and every webhook fails signature verification. Strip with
`sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'` first.

**Docker named volumes for `node_modules` go stale.** After adding a dependency,
`docker compose up --build` is not enough — the volume shadows the rebuilt image
layer. Remove it: `docker compose rm -sf <svc> && docker volume rm commerce_<svc>_node_modules`.

**`libs/outbox` must NOT have its own `typeorm`.** It is a peerDependency on
purpose. A second copy registers `@Entity` metadata in a different store and the
host's DataSource never finds the outbox tables. `tsconfig.base.json` pins
`typeorm` and `@nestjs/*` to one copy for typechecking only.

**If a service crash-loops on an unmigrated database**, `docker compose exec`
cannot reach it. Run the migration from the host instead —
`npm run migration:run --prefix apps/<svc>` — Neon is reachable from there.

**The Neon *projects* are named `users_db`, `catalog_db`, … but the database
inside each is `neondb`** (Neon's default). Do not be confused by the mismatch;
the connection strings are correct.

**Generated files are excluded from lint and prettier** (`libs/api-types`,
`openapi/`). Formatting them would fight the generator and the CI staleness
check could never pass again.

**The gateway forwards the raw body for `/api/v1/payments/webhook` only.**
Parsing and re-serialising JSON changes the bytes and Stripe's signature stops
verifying. Both the gateway and payments-service register `express.raw` for that
path before the JSON parser.

**Port conflicts.** 3000/6379 collide with other local projects on this machine
(`jobfit-redis`, a Jobfit Next.js dev server). Stop those first.

---

## 6. Verification already done — do not redo

All against the live stack with real Stripe test-mode payments.

| Scenario | Result |
|---|---|
| Happy path | 50 → 47 available, **0 reserved** — units left exactly once |
| Payment declined | 47 → 42 held → **back to 47/0 automatically in 6s** |
| Insufficient stock | Cancelled, stock untouched, payment **never attempted** (404) |
| Duplicate delivery | 8 `order.created` republished — nothing changed |
| **orders-service SIGKILLed mid-saga** | Paid while dead → restarted → completed to `confirmed`, 43/0 |
| Reservation expiry | Never paid → hold lapsed → returned, row marked `expired` |
| Broker outage (M3) | Order accepted with RabbitMQ down; event delivered on restart |
| Webhook replay | Same Stripe event twice → no second effect |
| Bad webhook signature | Rejected 400 |

Plus 39 unit tests and 5 Playwright E2E tests, all green. CI on GitHub is green.

---

## 7. Deliberate decisions someone might otherwise "fix"

- **The catalog price lookup is synchronous.** It is a *read* before anything
  commits, so a failure rejects the request cleanly. Only state-changing calls
  became events.
- **M2's synchronous code was thrown away on purpose**, and its failure is
  documented with real evidence in ADR-0002. That evidence is why the saga is
  justified rather than cargo-culted. Do not delete it.
- **Stripe Elements, not hosted Checkout.** The plan said Checkout; Elements was
  used because payments already returns a `clientSecret`. Same PCI tier (SAQ-A).
  Not yet recorded in an ADR — worth doing.
- **The browser never marks an order paid.** `confirmPayment` succeeding only
  triggers a re-poll. The webhook is the authority.
- **E2E tests are not in CI.** They need six services, five databases and a
  webhook tunnel. Mocking the backend would prove nothing about the saga.
  Standing the stack up belongs with M22.
- **Playwright does not drive Stripe's card iframe.** It confirms via Stripe's
  API and asserts the *page* notices. Driving their component would be testing
  their code and is the flakiest thing in any Stripe suite.

---

## 8. Deployment — done, with a caveat

M6 was finished with Cloudflare Tunnel (`bash scripts/tunnel-up.sh`), not a
managed platform: the Railway trial had expired on both available accounts.

Two defects were found and fixed on the way, both in code that had never been
run: the **production Docker stage did not boot** for five of six services
(`@libs/*` resolved to TypeScript), and `npm install --omit=dev` never installed
the libs' own dependencies because the app lockfiles were generated while
`libs/*/node_modules` existed. Details in `docs/DEPLOYMENT.md` §5 (Part B).

To make the deployment permanent, the original plan still stands:

1. A host — Railway is the pragmatic choice (free tier, Docker support). Fly.io
   also works. Kubernetes is M21 and deliberately later.
2. Six services from their existing Dockerfiles (`target: production`; the
   production stage exists and is untested).
3. RabbitMQ — Railway has a plugin, or CloudAMQP's free tier.
4. The five Neon databases already exist and are reachable from anywhere.
5. **A real Stripe webhook endpoint** instead of the CLI tunnel: add
   `https://<payments-host>/api/v1/payments/webhook` in the Stripe dashboard and
   use *that* signing secret.
6. Storefront on Vercel or Railway, with `NEXT_PUBLIC_API_URL` pointing at the
   deployed gateway.
7. CORS: the gateway currently allows `*`. Tighten it to the storefront origin.

Blocker: needs a Railway (or Fly) account. Everything else is prepared.

---

## 9. Outstanding debts

**Rotate four Neon passwords in `saas-business-platform`.** That repo is public
and has live credentials in five committed `.env.example` files, in git history.
They work today. Deleting the files does not help — rotation is the only fix.
This is unrelated to this repo but is the most urgent thing on the list.

**Roll the Stripe test secret key.** It was pasted into a chat transcript twice.
Dashboard → Developers → API keys → Roll, then update
`apps/payments-service/.env` and force-recreate the container.

**Enable the pre-commit hook on any new clone:**
`git config core.hooksPath .githooks`. The repo is public, so CI's secret scan
runs one moment too late; the hook is the real guard.

**No authorization yet (M16).** Orders are scoped to the caller, but there is no
role system, and staff-only endpoints (create product, adjust stock) are
protected by nothing but a valid JWT. The plan lists M16 as never-cut.

**No observability (M19).** Correlation ids are propagated but there is no
tracing, no metrics, no dashboards. Debugging six services without it gets
painful fast.

**No dead-letter queue (M18).** A message that keeps failing is nacked with
`requeue=false` — dropped rather than quarantined.

---

## 10. Working agreements from this project

- One commit per milestone, short subject line.
- Verify claims by running them, not by reasoning about them. Several bugs in
  this project were found only because a test was actually executed —
  including two in code written moments earlier.
- When a check fails, confirm *why* before fixing. A secret-scanner "pass" that
  was really scanning the wrong directory, and a hook test that reported failure
  because of a piped exit code, both looked like results and were not.
- State what was not done and why, rather than letting scope quietly shrink.
