# M7 — Cart: implementation plan

**Written:** 2026-09-03
**Status:** Draft for review — no code written yet
**Milestone:** M7, first of R2

Read §3 and §4 before agreeing to this. They contain the two places where I
think the original plan needs to change, and one of them would break guest carts
in the deployed setup if followed literally.

---

## 1. What M7 is for

Today there is no cart: the storefront's "Buy now" posts a single product
straight to `POST /orders`. You cannot buy a mug and a cable together.

The milestone is not "a list of items". It is **state owned by someone who has
not identified themselves yet, later reconciled with a real account**. A shopper
adds three things while logged out, then logs in at checkout, and the shop has
to decide what their cart now contains.

That is the same problem as a guest's draft document surviving signup, or
analytics spanning an anonymous and identified session. Carts are the clearest
instance of it.

The secondary purpose is storage choice with a reason behind it. Guest carts are
mostly abandoned and disposable; user carts must survive. That is why
`docker-compose.yml` has carried an unused Redis since M0 — this is the
milestone it was reserved for.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Merge rule | **Sum quantities**, capped at available stock | Nothing the shopper chose disappears. Easiest to explain when they are confused. |
| Guest storage | Redis, with TTL | Most guest carts never become orders; TTL expiry means no cleanup job. |
| User storage | Postgres (sixth Neon database) | Must survive across devices and sessions. |
| Cart contents | `productId` + `qty` **only — no prices** | Handoff §7 records that catalog price lookup is deliberately synchronous, done as a read before anything commits. Storing prices in the cart reintroduces exactly the staleness that avoids, and would fight M8 when pricing gets its own service. |

---

## 3. Change I recommend: do not key guest carts on a cookie

The plan says "guest carts in Redis keyed by cookie". Followed literally, that
breaks in the deployment we actually have.

The storefront and the gateway are on **different origins** — two separate
Cloudflare Tunnel hostnames today, and two separate domains under the Railway
plan. A cookie set by the gateway and sent from the storefront is therefore a
**third-party cookie**. It requires `SameSite=None; Secure`, and current browsers
block or partition third-party cookies by default. Guest carts would silently
fail for a large share of visitors, and worse, would work fine in local
development where both are on `localhost`.

**Recommendation:** identify a guest cart with an opaque token the client stores
and sends as a header — `x-cart-token`, mirroring how the JWT is already carried.
No cookie, no cross-site problem, no divergence between local and deployed
behaviour.

The cost is that the token lives in `localStorage`, so it is readable by scripts
on the storefront origin. For an anonymous cart holding only product ids and
quantities, that is not a meaningful exposure — it is strictly less sensitive
than the auth token already stored the same way.

If you would rather keep cookies, that is defensible, but then guest carts
should be tested from the deployed URLs early, not at the end.

---

## 4. Change I recommend: leave `POST /orders` alone

The obvious design is for checkout to read the cart server-side, so the client
cannot declare what it is buying. I do not think that is right here.

`POST /orders` already takes `items[]`, and it is the entry point of the saga —
the most carefully built and most thoroughly tested code in the repo. Making
orders read from cart-service also introduces an orders → cart dependency for
what is fundamentally a pre-order convenience.

The usual argument for server-side reads is tamper resistance, and it does not
apply: **prices are looked up server-side from catalog, and stock is checked
server-side by inventory.** A client sending different items is just ordering
different things, which it could already do by calling the API directly. There
is no privilege to escalate.

**Recommendation:** the storefront sends cart contents to the unchanged
`POST /orders`. cart-service then **consumes `order.created`** and clears that
customer's cart. The dependency runs cart → events, which is the pattern already
established, and the saga entry point is untouched.

Open question for later, not now: if an order is cancelled, should the cart come
back? I suggest no — that is what a "reorder" button is for.

---

## 5. Shape of the service

Follows §1.1 of IMPLEMENTATION_PLAN.md exactly; nothing novel in the layout.

```
apps/cart-service/          port 3006
  src/
    main.ts, app.module.ts, health.controller.ts
    config/typeorm.config.ts
    database/migrations/
    modules/cart/
      cart.controller.ts
      cart.service.ts          orchestrates the two stores
      guest-cart.store.ts      Redis
      user-cart.store.ts       Postgres
      cart-merge.ts            pure function — the interesting part
      cart.entity.ts, cart-item.entity.ts
      dto/
    events/
      outbox.entity.ts, outbox.relay.ts
      processed-event.entity.ts
      handlers/order-created.handler.ts     clears the cart
      cart-abandonment.job.ts
```

`cart-merge.ts` is deliberately a **pure function** — `(guestItems, userItems,
stockLevels) => mergedItems`. It is where the milestone's actual thinking lives,
so it should be testable without Redis, Postgres, or HTTP.

### Gateway

**No work required.** `/api/v1/cart` already routes to
`http://cart-service:3006` — see `services.config.ts:22`. The route is live right
now, proxying to a service that does not exist yet.

### Data

Redis, guest carts:
```
key    cart:guest:<token>
value  { items: [{ productId, qty }], createdAt, updatedAt }
TTL    CART_GUEST_TTL_DAYS, default 30
```

Postgres, user carts:
```
carts       id, customer_id (unique), created_at, updated_at
cart_items  id, cart_id (fk), product_id, qty, created_at, updated_at
            unique (cart_id, product_id)
```

The unique constraint on `(cart_id, product_id)` is what makes "add the same
thing twice" an update rather than a duplicate row, and it is what the merge
relies on.

### Endpoints

All under `/api/v1/cart`, all resolving the caller as user (JWT) or guest
(`x-cart-token`):

```
GET    /cart                     current cart
POST   /cart/items               { productId, qty }
PATCH  /cart/items/:productId    { qty }
DELETE /cart/items/:productId
DELETE /cart                     clear
```

**Merging is not an endpoint.** When a request arrives carrying both a valid JWT
and an `x-cart-token`, cart-service merges, deletes the guest key, and tells the
client to drop the token. Doing it this way means merging cannot be forgotten by
the storefront, and works no matter which page the shopper logged in on.

---

## 6. The merge rule, precisely

Sum quantities, then cap at available stock:

```
merged[productId] = min(guestQty + userQty, availableQty)
```

Cases the unit tests must cover:

| Case | Expected |
|---|---|
| Product in guest cart only | carried over as-is |
| Product in user cart only | left alone |
| Product in both (2 + 3) | **5** |
| Sum exceeds stock (4 + 4, stock 6) | capped to 6 |
| Product now out of stock | dropped, and reported in the response |
| Guest cart empty | user cart unchanged |
| User cart empty | guest cart adopted wholesale |
| Product deleted from catalog since adding | dropped, and reported |

**The stock cap is advisory, not a reservation.** Stock is only genuinely held
during the saga. Two shoppers can both merge to 6 of the last 6 units; the loser
finds out at checkout, where the existing "insufficient stock" path already
handles it correctly and is covered by an e2e test. This must be stated in code
comments or someone will later mistake the cap for a guarantee.

Reading stock means one synchronous call from cart-service to inventory-service.
That is consistent with the precedent in handoff §7: it is a **read before
anything commits**, so a failure rejects the request cleanly. If inventory is
unreachable, merge without the cap rather than failing the login.

---

## 7. Abandonment

Postgres carts: a scheduled sweep finds carts untouched for
`CART_ABANDON_AFTER_DAYS` and appends `cart.abandoned` to the outbox.

Guest carts need no job at all — Redis TTL expires them. Worth a comment,
because the asymmetry is the clearest illustration of why the two stores differ.

Be honest that **nothing consumes `cart.abandoned` yet**; recovery email is R3 at
the earliest. It is emitted so the history exists and the outbox path is
exercised. If that feels like building for an imagined future, cutting the job
from M7 costs nothing and the plan should say so out loud.

---

## 8. Storefront

- Cart icon with item count in the header
- Cart page: change quantities, remove lines, subtotal
- "Add to cart" on the product page — **keep "Buy now" too**, since it is what
  the Playwright suite drives today and removing it rewrites those tests for no
  benefit
- Checkout posts cart contents to the existing `POST /orders`
- On login, if a merge happened, say so plainly — especially when something was
  dropped for being out of stock

---

## 9. Definition of Done

Per IMPLEMENTATION_PLAN §1.6, plus what is specific here:

- [ ] Works through the gateway, not just against the service
- [ ] Migrations reversible (`down` implemented)
- [ ] `cart-merge.ts` unit-tested across every row in §6
- [ ] Integration test: guest adds, logs in, cart merged correctly
- [ ] Playwright: guest cart survives login on the deployed URLs
- [ ] Swagger regenerated, storefront types regenerated
- [ ] `/health` and `/ready` correct
- [ ] ADR for the two §3/§4 decisions if accepted
- [ ] `docs/DEPLOYMENT.md` updated — **it currently says not to deploy Redis**

---

## 10. Before starting

1. **A sixth Neon database** for cart-service.
2. **Redis stops being decorative.** It is a real dependency from M7 on, which
   makes the port 6379 collision with `jobfit-redis` an actual blocker rather
   than an annoyance, and means `DEPLOYMENT.md`'s "do not deploy Redis" is wrong
   as of this milestone.
3. **Roll the Stripe test key** — still outstanding from handoff §9, still
   leaked in a chat transcript, and now also registered on a webhook endpoint.
   Two minutes, and better done before more is built on top.

## 11. Suggested order of work

1. `cart-merge.ts` and its unit tests — no I/O, pure logic, the actual milestone
2. Service scaffold, Postgres store, migrations
3. Redis guest store and token resolution
4. Automatic merge on authenticated request
5. `order.created` consumer that clears the cart
6. Storefront cart UI
7. Abandonment job — or drop it, per §7

Steps 1–2 are a reasonable first sitting and produce something reviewable.
