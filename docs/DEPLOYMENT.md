# Deployment

**Written:** 2026-09-01, updated 2026-09-02. Finishes M6: "a stranger can place
a test-mode order end to end on a public URL."

Two paths are documented here. **Part A is what is actually live.** Part B is
the managed-platform plan, blocked only on a Railway plan; §1's explanation of
how the pieces connect applies to both.

---

# Part A — Cloudflare Tunnel (current)

Railway's trial expired, so M6 was completed with Cloudflare Tunnel instead.
The code runs on the development machine; Cloudflare provides the public HTTPS
front. It is a demo deployment, not a 24/7 one — the URLs live only while the
machine and the tunnels are up. Part B remains the path to a real deployment.

```bash
docker compose up -d              # the backend stack, unchanged
bash scripts/tunnel-up.sh         # publish; prints both public URLs
bash scripts/tunnel-down.sh       # unpublish and clean up
```

### Why a script rather than a command

A quick tunnel mints a **new random hostname every run**, and three things are
bound to that hostname:

1. **The storefront bundle.** `NEXT_PUBLIC_API_URL` is inlined by `next build`,
   so a new gateway URL means a rebuilt image — not a restart.
2. **The gateway's CORS allowlist.** The browser loads the page from the
   storefront host and calls the API on the gateway host: cross-origin. Without
   `CORS_ORIGINS` the browser discards every response.
3. **The Stripe webhook endpoint**, which carries its own signing secret.

So publishing is a re-wire in a fixed order — gateway tunnel, storefront build,
storefront tunnel, CORS, Stripe — and doing it by hand invites getting one step
out of order. `tunnel-up.sh` does exactly that sequence and re-registers the
Stripe endpoint, deleting the dead one from the previous run.

### Two tunnels, not one

A single tunnel to the storefront with Next.js rewriting `/api/*` to the gateway
would give one URL, no CORS and no rebuilds. It was rejected: it puts a Next.js
proxy hop in front of the Stripe webhook, and re-serialising that body by one
byte breaks signature verification. The gateway stays the direct entry point.

### Verified on the live public URLs

| Scenario | Result |
|---|---|
| Register, order, pay (`pm_card_visa`) | `confirmed`, stock 50 → 48, reserved 0 |
| Declined card (`pm_card_chargeDeclined`) | held 3 → `cancelled` → **stock returned automatically** |
| Stripe webhook signature | 0 failures; `webhook_events` rows written, outbox relayed |
| CORS | storefront origin allowed; other origins get no header |

Real Stripe test-mode webhooks over the public URL, `livemode: false` throughout.

### Known limits

- **Only up while the machine is.** Closing the laptop takes the site down.
- **URLs change on every run**, so a link shared today is dead tomorrow. A free
  Cloudflare account with a domain gives stable named tunnels and removes this.
- **`docker compose` still runs the `development` targets.** The storefront runs
  from its production image; the six services do not. The production images are
  built and verified (Part B §5) but are not what these tunnels serve.
- Port 6379 collides with `jobfit-redis`; stop it first (`docker stop jobfit-redis`).

---

# Part B — Railway (prepared, not applied)

Read §1 before clicking anything in Railway. The ordering in §4 is not
arbitrary — two of the steps cannot be reversed without a rebuild.

---

## 1. How the pieces connect in production

Locally, Docker Compose gives every container a DNS name on one bridge network
and `.env` files supply configuration. Railway replaces both. Nothing else about
the system changes:

| Local | Production |
|---|---|
| Compose service name (`users-service:3001`) | `users-service.railway.internal:3001` |
| `env_file: ./apps/*/.env` | Railway service variables |
| `rabbitmq:5672` container | RabbitMQ service on Railway |
| Neon over the internet | **Neon over the internet — unchanged** |
| `stripe listen` CLI tunnel | Real webhook endpoint in the Stripe dashboard |

Three properties of the code make this a configuration change rather than a
rewrite. All three were verified before deploying:

- **Every address is an environment variable.** `services.config.ts`,
  `RABBITMQ_URL` and `DATABASE_URL` only fall back to Compose hostnames.
- **Services bind `[::]`,** the IPv6 wildcard. Railway's private network is
  IPv6-only; Node's default bind accepts both families, so no code changed.
- **Databases are already external.** The five Neon instances are reachable from
  anywhere. No data moves during this deployment.

### What is public and what is not

Only **two** services get a public domain: the **gateway** and the
**storefront**. The other four are reachable only on `*.railway.internal`.

That is the architecture's existing rule — "nothing is reachable from a browser
except the gateway" — and it is also the security boundary. There is no
authorization layer yet (M16), so staff-only endpoints are protected by nothing
but a valid JWT. Those services must not be internet-facing.

```
     browser ──────► storefront (public)
        │                 │  NEXT_PUBLIC_API_URL, baked at build time
        └─────────────────┴──► api-gateway (public)
                                    │  private network
              ┌────────────┬────────┼──────────┬─────────────┐
          users        catalog   inventory   orders       payments
              └────────────┴────────┴──────────┴─────────────┘
                              │                      │
                          RabbitMQ            Stripe webhook
                                              (public, via gateway)

              each service ──► its own Neon database
```

### Why the Stripe webhook goes through the gateway

Stripe signs the literal bytes of the request body. Parsing and re-serialising
JSON changes those bytes and the signature stops verifying. Both the gateway and
payments-service already register `express.raw` for
`/api/v1/payments/webhook` before the JSON parser, so the bytes survive the hop.

Routing the webhook through the gateway keeps payments-service private and uses
machinery that already exists. Do not give payments-service its own public
domain to "simplify" this.

### Why `NEXT_PUBLIC_API_URL` forces the deploy order

Next.js inlines `NEXT_PUBLIC_*` into the browser bundle **at build time** and
never reads them again at runtime. The gateway's public domain must therefore
exist *before* the storefront image is built. Changing the API URL later means
rebuilding the storefront, not editing a variable.

---

## 2. Databases: reuse or branch

The five Neon databases are already migrated and seeded. Pointing Railway at
them is zero work and the fastest route to a working public URL.

The tradeoff: **local development and the public site then share state.** A
stranger's test order appears in your local stack, and a local experiment
appears on the public site. For a portfolio demo that is usually acceptable.

If you want separation, create a Neon **branch** per database and give Railway
the branch connection strings. Branches are copy-on-write, so each starts with
the schema and seed data already present, and costs nothing extra.

Either way **migrations are already applied**, so there is no migration step in
§4. If you branch and later add a migration, run it from your machine with
`npm run migration:run --prefix apps/<service>` — Neon is reachable from there,
which is also the documented workaround when a service crash-loops.

---

## 3. Variables

`JWT_SECRET` must be **byte-identical** across the gateway and all five
services, or tokens signed by users-service are rejected everywhere else. Put it
in a Railway **shared variable** and reference it rather than pasting it six
times.

Set `PORT` explicitly per service to its canonical port. Railway would otherwise
assign one, and the internal URLs below would drift.

| Service | Variables |
|---|---|
| api-gateway | `PORT=3000`, `JWT_SECRET`, `CORS_ORIGINS`, `USERS_SERVICE_URL`, `CATALOG_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `ORDERS_SERVICE_URL`, `PAYMENTS_SERVICE_URL` |
| users-service | `PORT=3001`, `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET` |
| catalog-service | `PORT=3002`, `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET` |
| inventory-service | `PORT=3003`, `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `CATALOG_SERVICE_URL` |
| orders-service | `PORT=3004`, `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `CATALOG_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `PAYMENTS_SERVICE_URL` |
| payments-service | `PORT=3005`, `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| storefront | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — both **build-time** |

Internal URLs take the form `http://<service>.railway.internal:<port>`, for
example `USERS_SERVICE_URL=http://users-service.railway.internal:3001`.

`NODE_ENV=production` is set by the Dockerfiles; you do not need to add it. Note
that it makes `RABBITMQ_URL` mandatory — `validateEnv` refuses to start without
it, by design.

`REDIS_URL` appears in the `.env.example` files but nothing reads it yet. Do not
deploy Redis; it would cost money and do nothing.

**Do not wrap values in quotes** in the Railway UI. The local `.env` files use
`'single quotes'`, which Compose strips and Railway would not. A quoted
`DATABASE_URL` fails with `getaddrinfo ENOTFOUND base`.

---

## 4. Deploy, in order

Each step depends on the one before it.

1. **Create the project** from the GitHub repo. Railway builds the last stage of
   each Dockerfile, which is `production` in all seven — no build target needs
   configuring.

2. **RabbitMQ.** Add a service from the `rabbitmq:3-management-alpine` image,
   with a volume on `/var/lib/rabbitmq` and non-default credentials. Note its
   internal host for `RABBITMQ_URL`.

3. **The four leaf services** — users, catalog, inventory, payments. For each:
   Root Directory `/`, config file `deploy/railway/<service>.json`, and the
   variables from §3. Give none of them a public domain.

4. **orders-service.** Same settings, after the four above — it calls catalog,
   inventory and payments.

5. **api-gateway.** Same, then **generate a public domain**. Set the internal
   `*_SERVICE_URL` variables. Leave `CORS_ORIGINS` unset for now; the
   storefront's origin does not exist yet.

6. **Stripe webhook.** In the Stripe dashboard, in **test mode**, add the
   endpoint `https://<gateway-domain>/api/v1/payments/webhook`, subscribe to
   `payment_intent.succeeded` and `payment_intent.payment_failed` — the only
   two the service handles; refunds are service-initiated, not webhook-driven —
   then copy **that endpoint's** signing secret into
   payments-service's `STRIPE_WEBHOOK_SECRET`. It is a different secret from the
   CLI's, and the CLI's will not work here.

7. **Storefront.** Root Directory `/storefront`, config file
   `deploy/railway/storefront.json`. Set `NEXT_PUBLIC_API_URL` to
   `https://<gateway-domain>/api/v1` **before the first build**, then generate
   its public domain.

8. **Close CORS.** Set the gateway's `CORS_ORIGINS` to the storefront's origin
   (for example `https://storefront-production.up.railway.app`, no trailing
   slash) and redeploy. Left unset the gateway allows every origin — acceptable
   while nothing is public, wrong once it is.

### Verify

```bash
curl https://<gateway-domain>/api/v1/health
curl https://<gateway-domain>/api/v1/catalog/products     # the seeded products
```

Then place an order on the storefront with Stripe test card `4242 4242 4242
4242` and confirm it reaches `confirmed`. That exercises the whole saga:
reservation, payment, webhook, commit. Card `4000 0000 0000 0002` is declined
and must return the stock automatically within a few seconds.

---

## 5. What was wrong, and what was fixed

**The production Docker stage had never been run.** It did not work. Two
defects, both fixed:

- Only the gateway loaded `register-node-path.js`. Every workspace lib declares
  `"main": "src/index.ts"`, so the other five services resolved `@libs/*` to
  TypeScript that `node` cannot execute, and crashed on boot. All six now load
  it, and it covers all four libs rather than two.

- `npm install --omit=dev` did not install the libs' own dependencies, so
  `@nestjs/passport` was missing at runtime. Each app's `package-lock.json` was
  generated while `libs/*/node_modules` existed on the host, so npm recorded
  those dependencies as already satisfied and a clean install could never
  produce them. `--install-links` installs `file:` dependencies as real packages
  and resolves them properly.

  **The app lockfiles are still incomplete** and worth regenerating. Be careful:
  a bare `npm install` inside `libs/outbox` would install its `typeorm` *peer*
  dependency locally and reintroduce the two-copies bug in handoff §5. Verified
  the images contain exactly one `typeorm`.

**The build stage needs dependencies the runtime does not:** the root
devDependencies that `tsconfig.base.json` pins `typeorm` and `@nestjs/*` to for
typechecking, and the libs' own `@types` packages. The development target only
ever had them because Compose bind-mounts the host tree over the image.

**Verified before deploying:** all six services build and boot; users-service
was run against real Neon and RabbitMQ and served `/api/v1/ready` → `200`; the
storefront serves on an injected `$PORT`; lint is clean and all 39 unit tests
pass.

---

## 6. Not done here

- **Playwright against the deployed stack.** Still local-only. Standing the
  stack up in CI belongs with M22.
- **`docker-compose.yml` still targets `development`.** Deliberately unchanged —
  the local workflow is untouched by any of this.
- Observability (M19), dead-letter queues (M18) and authorization (M16) remain
  open. M16 is the reason only the gateway is public.
