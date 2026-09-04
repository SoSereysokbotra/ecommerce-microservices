# Handoff — read this first

**Written:** 2026-09-01. **Last updated:** 2026-09-03 (M7 complete).
**Repo:** https://github.com/SoSereysokbotra/ecommerce-microservices (public, `main`)
**Local:** `d:\Year2\Microservices\Order‑Inventory‑Payment Microservices\ecommerce-microservices`

This document exists so a new session can continue without re-deriving anything.
Read it fully before touching code — several things here were learned the hard
way and will cost hours to rediscover.

**Where things stand (2026-09-03):** R1 is finished and deployed (via Cloudflare
Tunnel, from this machine). R2 has begun: **M7 (cart) is complete**, all seven
steps committed. **The next milestone is M8 — tax and discounts.**

If you are starting fresh, read in this order:

1. This file, §2 (status) and §5 (gotchas).
2. `docs/M7_CART_PLAN.md` — only if you are touching cart-service. It records two
   deliberate departures from `IMPLEMENTATION_PLAN.md` that look like mistakes
   otherwise.
3. `docs/DEPLOYMENT.md` — only if you are deploying.
4. `docs/IMPLEMENTATION_PLAN.md` §3, the M8 entry, before starting the next
   milestone.

Do not re-verify what §6 lists as already verified.

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

## 2. Status: 8 of 23 milestones done — R1 complete, R2 started

| | Milestone | State |
|---|---|---|
| M0 | Skeleton: gateway + users-service | done |
| M1 | catalog-service + inventory-service | done |
| M2 | Orders, deliberately synchronous (thrown away) | done |
| M3 | Transactional outbox + idempotent consumers | done |
| M4 | Stripe payments, webhooks, refunds | done |
| M5 | **The saga** — compensation, expiry, crash recovery | done |
| M6 | Storefront + Playwright + public deployment | done |
| **M7** | **Cart: guest carts, merge on login, abandonment** | **done** |
| M8 | Pricing: tax + discounts | **next** |
| M9–M22 | Rest of R2, then R3–R5 | not started |

**M6** was met on 2026-09-02 via **Cloudflare Tunnel**, not a managed platform —
Railway's trial had expired on the available account. Verified with real Stripe
test-mode webhooks over the public URL, including the declined-card compensation
path. The tunnel serves from **this machine**, so the site is up only while it
is. That satisfies M6 but is not a 24/7 deployment. See `docs/DEPLOYMENT.md`:
Part A is what was actually done, Part B is the Railway plan, still prepared and
still blocked on a paid plan.

**M7** was completed on 2026-09-03 in seven steps, each committed separately.
The full design, every decision and what was verified is in
**`docs/M7_CART_PLAN.md`** — read that before touching cart-service; it explains
two deliberate departures from `IMPLEMENTATION_PLAN.md` (§3 and §4 of that file)
and would otherwise look like mistakes.

**Next task: M8 — tax and discounts (`pricing-service`).** The plan's warning
for it is rounding: round once, at the end, and test totals across three tax
regions.

### What M7 added, in one paragraph

A seventh service, `cart-service` on **port 3006**, with its own Neon database.
Signed-in carts live in Postgres, guest carts in **Redis** — which is why Redis
had been sitting unused in `docker-compose.yml` since M0. A guest can build a
cart with no account; when they sign in, the guest cart is **summed** into their
account's cart, capped at available stock. The cart is emptied by consuming
`order.created`, so `POST /orders` — the saga's entry point — was not touched.
A sweep flags carts nobody has touched for a week with `cart.abandoned`.

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
| cart-service | 3006 | Guest + signed-in carts, merge on login, abandonment sweep |
| storefront | 3100 | Next.js UI |

Supporting: RabbitMQ (5672 / 15672), Redis (6379 — **actually used since M7**,
for guest carts; before that it was declared and idle).

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
| `apps/cart-service/.env` | `DATABASE_URL` (its own Neon db), `REDIS_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `INVENTORY_SERVICE_URL` |
| `apps/api-gateway/.env` | `JWT_SECRET`, `CORS_ORIGINS` |
| `storefront/.env.local` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |

`JWT_SECRET` must be **identical** across the gateway and all services.
`scripts/setup.sh` generates one and copies it everywhere.

### Start

On the original dev machine everything is already provisioned, so this is all it
takes:

```bash
docker stop jobfit-redis          # it holds port 6379; see §5
docker compose up -d              # 7 services + RabbitMQ + Redis
cd storefront && npm run dev      # http://localhost:3100
```

Allow about a minute. **cart-service takes ~50s to become healthy** because a
cold Neon endpoint is slow to accept its first connection; its healthcheck has a
90s `start_period` for exactly this reason. Nothing is wrong.

Card payments additionally need webhooks reaching you, in its own terminal:

```bash
stripe listen --forward-to http://127.0.0.1:3000/api/v1/payments/webhook
```

Copy the `whsec_...` it prints into `apps/payments-service/.env`, then
`docker compose up -d --force-recreate payments-service`. It mints a **new**
secret every session — see §5.

To publish it on a public URL instead: `bash scripts/tunnel-up.sh`, and
`bash scripts/tunnel-down.sh` to take it down. That script does the whole
re-wire (tunnels, storefront rebuild, CORS, Stripe endpoint) in the one order
that works.

### First time on a new machine

Migrations and seeds, once per database. Six databases now — cart-service was
added in M7:

```bash
for s in users catalog inventory orders payments cart; do
  npm run migration:run --prefix apps/$s-service
done

# Seed in this order — the inventory seed asks catalog for ids over HTTP
npm run seed --prefix apps/catalog-service
npm run seed --prefix apps/inventory-service
```

Run migrations **from the host**, not `docker compose exec`: Neon is reachable
from either, and a service that is crash-looping on an unmigrated database
cannot be exec'd into.

### Checks

```bash
npm run lint
npm run test:all                    # 55 unit tests, no database needed
npm run gen:spec && npm run gen:types   # gen:spec needs the stack running
bash scripts/scan-secrets.sh
```

The 9 Playwright tests need the stack, the storefront on :3100, `stripe listen`
running, **and the Stripe key exported** — without the last one the two payment
tests fail with an error that looks like a code bug:

```bash
cd storefront
STRIPE_SECRET_KEY=$(grep '^STRIPE_SECRET_KEY=' ../apps/payments-service/.env | cut -d= -f2- | tr -d "'") E2E_BASE_URL=http://127.0.0.1:3100 E2E_API_URL=http://127.0.0.1:3000/api/v1 npx playwright test
```

`npm run lint` inside `storefront/` currently fails on one pre-existing error —
see §9.

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
(`jobfit-redis`, a Jobfit Next.js dev server). Stop those first. Since M7 this
matters more: Redis is a real dependency now, not a spare container.

### Learned during M6 and M7 — same category, newer

**`localhost` and `127.0.0.1` are not interchangeable here.** `curl` to
`http://localhost:3000` returns nothing (000) while `http://127.0.0.1:3000`
works — `localhost` resolves to `::1` first and Docker's proxy answers on IPv4.
Use `127.0.0.1` in scripts. Browsers are fine with either.

**The production Docker stage had never been run, and did not work.** Fixed in
M6. Every workspace lib declares `"main": "src/index.ts"`, so a compiled service
resolving `@libs/*` finds TypeScript that `node` cannot execute; all six now
load `register-node-path.js`. And `npm install --omit=dev` did not install the
libs' own dependencies, because each app's `package-lock.json` was generated
while `libs/*/node_modules` existed — `--install-links` fixes it. **The app
lockfiles are still incomplete**; regenerating them is worthwhile but a bare
`npm install` inside `libs/outbox` would install its `typeorm` peer dependency
locally and reintroduce the two-copies bug above.

**`CORS_ORIGINS` left over from a tunnel session silently breaks local dev.**
The gateway allowlist is exact. If it still points at a dead
`*.trycloudflare.com` host, the browser shows "Failed to fetch" for every API
call from `localhost:3100` and the app looks completely broken. Unset it to
allow everything, or point it at the origin you are actually using.

**Playwright's payment tests need `STRIPE_SECRET_KEY` in the shell**, not just in
`.env`. Without it they fail with an error that reads like a code bug. See §4.

**`next start` does not work with `output: "standalone"`.** The page returns 200
but static assets 404, so it looks subtly broken. Run
`node .next/standalone/storefront/server.js`, and copy `public/` and
`.next/static` into `.next/standalone/storefront/` first — the standalone output
nests under `storefront/`, not the top level. The Dockerfile already does this.

**A sweep that flags rows must not touch `updated_at`.** `repository.update()`
fires `@UpdateDateColumn`. In M7's abandonment sweep that would have made a
week-old cart look freshly active the moment it was flagged; the flag is written
with raw SQL to avoid it. Worth remembering for any future sweep.

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

### Added by M6 and M7 — also do not redo

| Scenario | Result |
|---|---|
| Full order on the **public tunnel URL**, real Stripe webhook | `confirmed`, stock 50 → 48, reserved 0 |
| Declined card on the public URL | `cancelled`, stock returned automatically |
| Guest cart → sign in (**2 + 3**) | **5**, guest token spent, no double-merge |
| Merge exceeding stock (32 + 32, 45 available) | capped to 45, adjustment reported |
| Invalid JWT on a cart route | `401` — optional auth is not a bypass |
| Duplicate `order.created` replayed | ignored; a refilled cart was untouched |
| Abandonment sweep | flags once, does not re-emit, clears when the shopper returns, never flags an empty cart |

**55 unit tests and 9 Playwright E2E tests, all green** (39 → 55 with M7's merge
tests; 5 → 9 with the cart suite). CI on GitHub is green.

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

### Added by M7 — full reasoning in `docs/M7_CART_PLAN.md`

- **Guest carts are keyed by a header token, not a cookie**, though
  `IMPLEMENTATION_PLAN.md` says cookie. The storefront and gateway are on
  different origins, so a cookie would be third-party and blocked by default —
  and it would have worked locally and failed in production. §3 of that file.
- **`POST /orders` was deliberately not changed.** Checkout still sends items
  from the client; cart-service consumes `order.created` to empty the cart. The
  tamper argument does not apply because prices come from catalog and stock from
  inventory, both server-side. §4.
- **The cart stores product ids and quantities only, never prices.** A cart that
  remembers a price is a cart that can show a stale one.
- **Merging is not an endpoint.** It happens inside `CartService.resolve()`,
  which every entry point runs, so the storefront cannot forget to trigger it.
- **`@OptionalAuth()` is a third auth state** between `@Public()` and guarded: no
  token is allowed through as a guest, but an *invalid* token is still rejected.
- **`cart.abandoned` has no consumer yet** and the plan says cutting the sweep
  would cost nothing today. It was built anyway; that is the one piece of M7
  written for an imagined future.

---

## 8. Deployment — done, with a caveat

M6 was finished with Cloudflare Tunnel (`bash scripts/tunnel-up.sh`), not a
managed platform: the Railway trial had expired on both available accounts.

Two defects were found and fixed on the way, both in code that had never been
run: the **production Docker stage did not boot** for five of six services
(`@libs/*` resolved to TypeScript), and `npm install --omit=dev` never installed
the libs' own dependencies because the app lockfiles were generated while
`libs/*/node_modules` existed. Details in `docs/DEPLOYMENT.md` §5 (Part B).

`scripts/tunnel-up.sh` and `scripts/tunnel-down.sh` do the whole thing. The
ordering inside them is not arbitrary — a quick tunnel mints a new hostname every
run, and three things are bound to it: the storefront bundle
(`NEXT_PUBLIC_*` is inlined at build time, so it is a rebuild not a restart), the
gateway's `CORS_ORIGINS`, and the Stripe webhook endpoint with its own signing
secret.

**To make it permanent**, `docs/DEPLOYMENT.md` Part B is written, and
`deploy/railway/*.json` configs exist for all seven services plus the storefront.
It is blocked only on a paid Railway plan — the trial had expired on the
account available, and free tiers that sleep idle services would break the
30-second reservation sweep and the RabbitMQ consumers, which is the whole point
of the project. A single always-free VM running the existing `docker-compose.yml`
(Oracle Cloud) was the other option discussed and is still open.

Note that Part B's service list is now **seven** services, not six: cart-service
was added in M7 and needs its own Railway service, its own Neon database, and a
real Redis. The `deploy/railway/` directory does not yet have a `cart-service.json`.

---

## 9. Outstanding debts

**Rotate four Neon passwords in `saas-business-platform`.** That repo is public
and has live credentials in five committed `.env.example` files, in git history.
They work today. Deleting the files does not help — rotation is the only fix.
This is unrelated to this repo but is the most urgent thing on the list.

**Roll the Stripe test secret key.** It was pasted into a chat transcript twice.
Dashboard → Developers → API keys → Roll, then update
`apps/payments-service/.env` and force-recreate the container. **Still not done
as of 2026-09-03.**

**Rotate the cart-service Neon password.** The full connection string for the
M7 database was pasted into a chat transcript on 2026-09-03. Reset it in the
Neon console, put the new string in `apps/cart-service/.env`, then
`docker compose up -d --force-recreate cart-service`. Nothing is committed —
that `.env` is gitignored — but the credential is readable in the transcript
and that database is reachable from anywhere.

**Regenerate the app `package-lock.json` files.** Every one of them was written
while `libs/*/node_modules` existed, so they omit the libs' own dependencies and
a clean `npm install --omit=dev` cannot reproduce a working tree. Production
images work around it with `--install-links`. Doing this properly requires care:
a bare `npm install` inside `libs/outbox` would install its `typeorm` peer
dependency locally and reintroduce the two-copies bug in §5.

**One pre-existing lint error in the storefront.** `app/orders/[id]/page.tsx:51`
— "`poll` accessed before it is declared". It predates M7 and `npm run lint` in
`storefront/` fails because of it. The root `npm run lint` only covers
`{apps,libs}` so CI does not see it.

**Enable the pre-commit hook on any new clone:**
`git config core.hooksPath .githooks`. The repo is public, so CI's secret scan
runs one moment too late; the hook is the real guard.

**No authorization yet (M16).** Orders are scoped to the caller, but there is no
role system, and staff-only endpoints (create product, adjust stock) are
protected by nothing but a valid JWT. The plan lists M16 as never-cut. This is
also why only the gateway and storefront are ever given a public domain.

**No observability (M19).** Correlation ids are propagated but there is no
tracing, no metrics, no dashboards. Debugging six services without it gets
painful fast.

**No dead-letter queue (M18).** A message that keeps failing is nacked with
`requeue=false` — dropped rather than quarantined.

---

## 10. The next milestone: M8 — tax and discounts

From `docs/IMPLEMENTATION_PLAN.md` §3:

> `pricing-service`; `tax_rates` by country/region/category; percentage and fixed
> discounts; a single `POST /pricing/quote` that orders calls to price a basket.
> *Watch for:* rounding. Round once, at the end. Test totals across three regions.

Acceptance: order totals correct across three tax regions.

What M7 leaves you that M8 will want:

- The gateway **already routes** `/api/v1/pricing` to `http://pricing-service:3007`
  (`services.config.ts`), the same way it already routed `/cart` before
  cart-service existed. But check the auth posture before assuming it is free —
  that assumption was wrong for `/cart` and cost a debugging session. See §5.
- `cart-service` is the newest worked example of the standard service shape,
  including the outbox and idempotent-consumer wiring.
- The cart deliberately holds **no prices**, which is what leaves room for
  pricing-service to own them.
- A seventh Neon database will be needed, plus the usual `.env` with a matching
  `JWT_SECRET`.

Money is integer minor units everywhere; format only at the edge. That rule is
already in `IMPLEMENTATION_PLAN.md` §1.5 and matters more in M8 than anywhere
else so far.

---

## 11. Working agreements from this project

- One commit per milestone, short subject line.
- Verify claims by running them, not by reasoning about them. Several bugs in
  this project were found only because a test was actually executed —
  including two in code written moments earlier.
- When a check fails, confirm *why* before fixing. A secret-scanner "pass" that
  was really scanning the wrong directory, and a hook test that reported failure
  because of a piped exit code, both looked like results and were not.
- State what was not done and why, rather than letting scope quietly shrink.
