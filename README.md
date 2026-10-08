# Commerce Microservices

An order–inventory–payment system built to demonstrate distributed-systems
techniques that a CRUD application cannot: **saga-orchestrated checkout with
compensating transactions, the transactional outbox, and idempotent consumers.**

> **Status: M0–M5 complete, M6 all but deployment.** Six services, the full
> checkout saga with compensation, and a storefront — running locally only.
>
> **New here, or picking this up in a fresh session? Read
> [`docs/HANDOFF.md`](docs/HANDOFF.md) first.**

---

## Why this project

Reserving stock, charging a card, and releasing the stock when the charge fails
cannot be done inside one database transaction — the data lives in different
services, in different databases. Making that correct is the point of the project.

---

## Quick start

Requires Docker Desktop, Node 20+, and a [Neon](https://console.neon.tech)
account.

**1. Create the databases.** Every service owns its own Neon database. Three
are needed so far — they can be three databases inside one Neon project:

| Service | Database |
|---|---|
| users-service | `users_db` |
| catalog-service | `catalog_db` |
| inventory-service | `inventory_db` |

**2. Configure and start.**

```bash
bash scripts/setup.sh      # creates .env files and generates a shared JWT_SECRET
```

Paste each Neon connection string into the matching `apps/<service>/.env`:

```
DATABASE_URL=postgresql://<user>:<password>@<endpoint>.neon.tech/users_db?sslmode=require
```

> `apps/*/.env` is gitignored. **Never** put a real credential in
> `.env.example`, which is committed.

```bash
docker compose up -d       # starts the stack; waits for dependencies to be ready

# Migrate, then seed. Order matters: the inventory seed asks the catalog
# service for product ids over HTTP rather than reading its database.
docker compose exec users-service     npm run migration:run --prefix apps/users-service
docker compose exec catalog-service   npm run migration:run --prefix apps/catalog-service
docker compose exec inventory-service npm run migration:run --prefix apps/inventory-service

docker compose exec catalog-service   npm run seed --prefix apps/catalog-service
docker compose exec inventory-service npm run seed --prefix apps/inventory-service
```

Verify:

```bash
curl http://localhost:3000/api/v1/health

curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","name":"You","password":"Str0ngPassw0rd!"}'
```

| URL | What |
|---|---|
| http://localhost:3000/api/v1 | API gateway |
| http://localhost:3000/api/v1/docs | Swagger |
| http://localhost:15672 | RabbitMQ management (guest/guest) |

Databases are hosted on Neon; there is no Postgres container. See
`docs/adr/0001-new-repo-and-reuse.md` for why.

> **Port conflict?** This stack uses 3000–3007, 5672, 6380, 15672. If another
> local project holds one of them, stop that project first.

---

## Services

| Service | Port | Owns | Status |
|---|---:|---|---|
| api-gateway | 3000 | Routing, JWT, rate limiting, correlation IDs, traceparent propagation | **Running** |
| users-service | 3001 | Auth, customers, profile management | **Running** |
| catalog-service | 3002 | Products, categories, catalog events | **Running** |
| inventory-service | 3003 | Stock levels, inventory reservations | **Running** |
| orders-service | 3004 | Order lifecycle, checkout saga orchestrator | **Running** |
| payments-service | 3005 | Stripe, webhooks, refunds, idempotency | **Running** |
| cart-service | 3006 | Persistent user shopping carts, Redis cache | **Running** |
| pricing-service | 3007 | Price rules, bulk discounts, promotional calculations | **Running** |
| shipping-service | 3008 | Carrier rating, fulfillment tracking | **Running** |
| search-service | 3009 | OpenSearch product indexing, search queries | **Running** |
| reviews-service | 3010 | Product ratings, customer review moderation | **Running** |
| recommendations-service | 3012 | Co-purchase analytics, frequent product pairings | **Running** |
| storefront | 3011 | Next.js 14 web client with AlsoBought recommendations | **Running** |

Supporting infrastructure: Neon PostgreSQL (dedicated database per service), RabbitMQ (with DLX & poison message handling), Redis, OpenSearch.

---

## Conventions

Defined once and applied everywhere — see `docs/IMPLEMENTATION_PLAN.md` §1.

- **Money** is integer minor units plus an explicit currency. Never a float.
- **Events** use one envelope with `eventId`, `correlationId` and `version`, and
  are named `<aggregate>.<past-tense-verb>` — facts, not commands.
- **Publishing** goes through an outbox row written in the same transaction as
  the business change, never directly to the broker.
- **Consumers** are idempotent: the processed-event marker and the effect share
  one transaction.
- **Health** is split — `/health` is liveness (never touches a dependency),
  `/ready` is readiness (checks the database). Compose gates startup on `/ready`.
- **Secrets** are validated at boot. A service refuses to start rather than fall
  back to a default.

---

## Security

`.env.example` files contain **placeholders only**. `scripts/scan-secrets.sh`
runs in CI and fails the build if a credential aimed at a remote host, or a known
provider token prefix, is ever committed.

Run it locally before pushing:

```bash
bash scripts/scan-secrets.sh
```

Card data must never reach these servers. Payments use Stripe's hosted checkout,
which keeps the project in PCI SAQ-A.

---

## API types

The frontend's types are generated, never hand-written — hand-mirrored types
drifting from the backend is what caused a 404 to ship in the previous project.

After changing any controller or DTO:

```bash
npm run gen:spec    # capture openapi/*.json from the running stack
npm run gen:types   # regenerate libs/api-types/src/*.d.ts
```

CI regenerates from the committed specs and fails if the result differs.

---

## Development

```bash
npm run lint
npm test --prefix apps/users-service
npx tsc --noEmit -p apps/api-gateway/tsconfig.json

docker compose logs -f api-gateway
docker compose restart users-service   # source is bind-mounted; no rebuild needed
```

Services run under `ts-node` without watch mode, so a code change needs
`docker compose restart <service>`.

---

## Observability & Monitoring (Grafana, Loki, Prometheus, Tempo)

The platform includes a complete production-grade observability stack supporting the **Three Pillars of Observability**:

* **Grafana (Port 3050):** Unified cockpit dashboard correlating metrics, logs, and distributed traces in one UI.
* **Prometheus (Port 9090):** Time-series metrics engine scraping service health, HTTP throughput, and CPU/memory usage.
* **Loki (Port 3101):** High-efficiency log aggregation engine receiving container logs streamed by **Promtail**.
* **Tempo (Port 3200, OTLP 4317/4318):** Distributed tracing backend rendering visual waterfall latency timelines across microservices.

### Starting and Stopping

```bash
npm run observability:up    # Starts Grafana, Prometheus, Loki, Promtail, and Tempo
npm run observability:down  # Stops the stack and frees system resources
npm run observability:logs  # Follows live logs from the observability stack
```

### Accessing the Web Interfaces

| Service | Local URL | Credentials / Purpose |
|---|---|---|
| **Grafana** | [http://localhost:3050](http://localhost:3050) | `admin` / `admin` (central UI for logs, traces, and dashboards) |
| **Prometheus** | [http://localhost:9090](http://localhost:9090) | Raw metric queries (PromQL) and target health checks |
| **Tempo** | [http://localhost:3200](http://localhost:3200) | Distributed trace storage and OTLP receiver (4317/4318) |

### Quick Query Cheatsheet in Grafana Explore

* **Live Container Logs (Loki):** In Grafana `Explore` ➔ select **Loki** ➔ query `{job="docker"}` or `{job="docker"} |= "error"`.
* **Health & Metrics (Prometheus):** In Grafana `Explore` ➔ select **Prometheus** ➔ query `up` (1 = online, 0 = down) or `process_resident_memory_bytes / 1024 / 1024` (RAM in MB).
* **Distributed Traces (Tempo):** In Grafana `Explore` ➔ select **Tempo** ➔ search `{}` or by service name (e.g. `api-gateway`) to inspect the visual latency waterfall across services.

---

## Documentation

| Document | Contents |
|---|---|
| `docs/HANDOFF.md` | **Start here** — state, setup, gotchas, next task |
| `docs/PROJECT_PLAN.md` | Scope, releases, risks, definition of done |
| `docs/IMPLEMENTATION_PLAN.md` | Build order, conventions, milestone tasks |
| `docs/adr/` | Architecture decision records |
