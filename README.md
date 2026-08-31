# Commerce Microservices

An order–inventory–payment system built to demonstrate distributed-systems
techniques that a CRUD application cannot: **saga-orchestrated checkout with
compensating transactions, the transactional outbox, and idempotent consumers.**

> **Status: M0 complete.** The gateway and authentication service run. Catalog,
> inventory, orders and payments are not built yet. See `../IMPLEMENTATION_PLAN.md`.

---

## Why this project

Reserving stock, charging a card, and releasing the stock when the charge fails
cannot be done inside one database transaction — the data lives in different
services, in different databases. Making that correct is the point of the project.

---

## Quick start

Requires Docker Desktop, Node 20+, and a [Neon](https://console.neon.tech)
account.

**1. Create the databases.** Every service owns its own Neon database. For M0
you need one:

| Service | Database |
|---|---|
| users-service | `users_db` |

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
docker compose exec users-service npm run migration:run --prefix apps/users-service
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

> **Port conflict?** This stack uses 3000–3001, 5672, 6379, 15672. If another
> local project holds one of them, stop that project first.

---

## Services

| Service | Port | Owns | Status |
|---|---:|---|---|
| api-gateway | 3000 | Routing, JWT, rate limiting, correlation ids | **Running** |
| users-service | 3001 | Auth, customers | **Running** |
| catalog-service | 3002 | Products, categories | M1 |
| inventory-service | 3003 | Stock, reservations | M1 |
| orders-service | 3004 | Order lifecycle, saga orchestrator | M2–M5 |
| payments-service | 3005 | Stripe, webhooks, refunds | M4 |

Supporting: Neon PostgreSQL (one database per service), RabbitMQ, Redis.

---

## Conventions

Defined once and applied everywhere — see `../IMPLEMENTATION_PLAN.md` §1.

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

## Documentation

| Document | Contents |
|---|---|
| `../PROJECT_PLAN.md` | Scope, releases, risks, definition of done |
| `../IMPLEMENTATION_PLAN.md` | Build order, conventions, milestone tasks |
| `docs/adr/` | Architecture decision records |
