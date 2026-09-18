# M13 — Reviews: implementation plan

**Written:** 2026-09-18
**Status:** Draft, for review. Nothing built yet.
**Milestone:** M13, second of R3

Read §3, §4 and §5 before agreeing to this. Each is a decision with a real
alternative, and §5 changes something M12 just proved.

- **§3 is a gap.** "Verified purchase from order events" needs to know *what*
  was bought. `order.confirmed` says who and how much; it does not say which
  products. One field has to be added, and the alternative (consuming
  `order.created` too) is worse for a reason worth writing down.
- **§4 is the rollup.** Who computes the average, and how it travels. The
  answer is a second versioned projection with its own clock, and the
  integer discipline from ADR-0010 applies to a star rating too.
- **§5 is the collision.** The `products` index will carry fields from two
  write sides. M12's `index()` replaces the whole document; a product edit
  would wipe the rating. Fixing that means moving the version guard from
  `version_type: external` into a script — the same guarantee, enforced a
  different way — and re-running M12's three no-op proofs. There is a
  cheaper option that loses "sort by rating". Both are laid out.

---

## 1. What M13 is for

`PROJECT_PLAN.md` §7:

> reviews-service; verified-purchase flag from order events; moderation
> queue; rating rollup. **Acceptance:** only customers who bought can
> review; average rating updates on publish.

Two claims. The first is an *authorisation derived from events*: the right
to review is not a role, it is a fact about the past that arrived on the
bus. The second is a *second projection onto the search index*: M12 put one
write side's data in the `products` document; M13 puts a second write side's
data on the same document, and the two must not fight.

The cut-order table lists M13 at position 5: "lose the verified-purchase
projection". That is the content — the reviews themselves are CRUD.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| New service | `reviews-service`, port **3010** | Reserved in `IMPLEMENTATION_PLAN.md` Appendix B; the gateway already routes `/api/v1/reviews` to it. |
| Store | Its own Neon Postgres | A review is written by a request. It is state, not a projection — unlike search, this service genuinely needs a database. |
| Idempotency | `processed_events` + outbox | The shipping-service shape (M10). Consumer of `order.confirmed`; publisher of the rollup. |
| One review per customer per product | UNIQUE `(product_id, customer_id)` | A second review is an edit. |
| Moderation | `pending → approved \| rejected`; only `approved` is public and counted | The plan's "moderation queue". The moderation UI is M17; M13 ships the endpoints. |
| Rating scale | integer 1–5 | No halves. |
| Where the average lives | On the `products` search document, as `ratingAvgE2` and `ratingCount` | The plan says "projected onto the search index". §4 and §5. |

---

## 3. The gap: `order.confirmed` does not say what was bought

```
payload: { orderId, customerId, currency, totalMinor, shippingMinor,
           shippingRateCode, shippingAddress }
```

No items. Reviews needs `(customerId, productId)` pairs, and it needs them
from a fact that means "this purchase happened", which is `order.confirmed`
— the saga's terminal success, emitted in the same transaction as the status
change (M9).

**Two ways to get them:**

1. **Add `items: [{ productId, sku, qty }]` to `order.confirmed`.** The M10
   rule, applied a third time: a field goes on an event when a consumer
   genuinely needs it, and this consumer cannot exist without it. The
   address went on in M10 for shipping; the items go on in M13 for reviews.
2. **Consume `order.created` (which has items) *and* `order.confirmed`.**
   Record pairs as "pending" on the first, flip them to "purchased" on the
   second. No change to any event.

**Recommendation: 1.** Option 2 leaves a row per cancelled order that has to
be cleaned up on `order.cancelled` (a third consumer), makes the right to
review depend on two events arriving in order, and puts a join across two
facts where one fact would do. It is the "callback instead of a frozen
value" shape M10 argued against, wearing a different hat. Option 1 is one
line in `order-saga.service.ts` and a payload interface; every existing
consumer ignores fields it does not read.

**What travels:** `productId`, `sku`, `qty`. Not the name or the price —
reviews does not display an order. `sku` is there because a support
conversation about "can this customer review X" is easier with a SKU than a
UUID, and it is already frozen on `order_items`.

---

## 4. The rollup: a second projection with its own clock

### Who computes the average

Not search-service. It has no database and cannot aggregate; it can only
apply what it is told. So **reviews-service keeps a `product_ratings` row
per product** — `rating_sum`, `rating_count`, `version` — updated **in the
same transaction** as the moderation decision that changed it, and emits
the whole row as `product.rating_changed`:

```
product.rating_changed   { productId, ratingSum, ratingCount, ratingAvgE2, version }
```

Full state, versioned, one event per change: the M12 shape exactly.
`version` is the rating row's own counter, bumped on every write. It is
**not** the product's version and **not** the category's — it is a third
clock, and §5 is about making three clocks share one document.

### Integers only

A star average is money-shaped: a number people compare, that must not
drift, that gets displayed rounded. ADR-0010's rule applies: **no floats
anywhere on the path**. `rating_sum` and `rating_count` are the stored
truth; `ratingAvgE2` is `round_half_up(sum × 100 / count)` computed in
BigInt at emit time and carried as an integer (437 = 4.37). The index sorts
on the integer; the storefront divides by 100 to render. Nothing ever
stores `4.37`.

### When it changes

| Event in reviews-service | Rollup |
|---|---|
| review created (`pending`) | unchanged — not public, not counted |
| `pending → approved` | `sum += rating`, `count += 1`, emit |
| `approved → rejected` | `sum -= rating`, `count -= 1`, emit |
| edit of an approved review's rating | `sum += new − old`, emit; **and the review returns to `pending`** (an edit is a new submission) — so in practice: `approved → pending` subtracts, later `pending → approved` adds |
| `rejected → approved` | as approved |

Every transition is one conditional UPDATE on `reviews` (status guard, the
M5 saga-step pattern) plus one UPDATE on `product_ratings` plus one outbox
row, in one transaction. A transition that does not match its guard is a
409, not a silent no-op.

---

## 5. The collision: two write sides, one document

Today `ProductsProjection.upsert()` does
`index({ id, version, version_type: 'external', body: fullDocument })`.
`index` **replaces the document**. The moment `ratingAvgE2` lives on it, any
`product.updated` — a price change, a republish — resets the rating to
nothing until the next `product.rating_changed` happens to arrive. That is
a lost update, and this project does not ship those.

The mapping is also `dynamic: strict`, so the two rating fields have to be
added to `products.index.ts`, and a mapping change is a reindex
(`recreate-index` + `republish`) — which now needs **two** republishes, one
per write side (§6).

### Option A — one scripted `_update` per write side, guards in the script

Replace `index()` with `update()` using `scripted_upsert: true`:

```
product event   script: if (ctx._source.version >= params.version) { ctx.op = 'none' }
                        else { set the product fields; leave rating* alone }
rating event    script: if (ctx._source.ratingVersion >= params.version) { ctx.op = 'none' }
                        else { set ratingSum/Count/AvgE2/ratingVersion; leave the rest alone }
category event  unchanged — already a script with the guard in the query
```

`retry_on_conflict: 3` handles two scripts racing on the document's
*internal* version: OpenSearch re-reads and re-runs, so the last writer
never wins by accident — each script re-checks its own clock.

**What this keeps:** the M12 guarantee in full. Redelivery, republication
and reordering are still no-ops; a stale write still loses. The store still
enforces it atomically — a script runs inside the document's compare-and-set,
not in application code. `result: 'noop'` is the new `'stale'`.

**What this changes:** the *mechanism*. ADR-0011 says the guard is
`version_type: external`; it becomes a comparison in painless, and the
`_version` OpenSearch tracks is no longer the product's. The upsert case
(document absent) is `scripted_upsert`, where `ctx._source` starts empty and
the script must handle a missing `version`. **M12's three no-op proofs must
be re-run** after the change — they are the milestone's content, and a
refactor of the mechanism that skipped them would be a refactor nobody
verified.

### Option B — a separate `product_ratings` index, merged at query time

Leave `products` and `ProductsProjection` untouched. Ratings go to their own
index, keyed by product id, written with `version_type: external` exactly as
products are. `SearchService.products()` runs the search, then `mget`s the
ratings for the page's hits and merges them in.

**What this keeps:** ADR-0011 as written; M12 untouched; one extra round
trip per search page.

**What this loses:** `sort=rating`. OpenSearch has no join; a sort on a
field in another index is not a thing. The acceptance criterion does not
ask for it, but a search page without "top rated" is missing the one thing
people use ratings for. Facet counts are unaffected.

### Recommendation: **Option A**

The plan says "projected onto the search index", and the lesson in it —
*several write sides can own disjoint fields of one read-model document if
each brings its own clock* — is the thing M13 teaches that M12 did not. It
is also the shape a real catalogue has (price from one system, stock from
another, ratings from a third). Option B is the fallback if A's re-proofs
turn up something ugly; the swap is confined to `ProductsProjection` and
`search.service.ts`.

If the reviewer prefers B for keeping M12's ADR pristine, say so — it is a
defensible reading of "don't touch what was just proved".

---

## 6. Shape of the changes

```
apps/orders-service/
  order-saga.service.ts                      order.confirmed gains items[] (§3)

apps/reviews-service/                        ** NEW — port 3010, own Neon db **
  src/database/migrations/
    …-CreateReviewTables.ts                  purchases, reviews, product_ratings
    …-CreateOutboxTables.ts                  outbox, processed_events (copy shipping's)
  src/modules/reviews/
    purchase.entity.ts                       (customer_id, product_id, order_id, sku, confirmed_at)
                                             UNIQUE(customer_id, product_id, order_id)
    review.entity.ts                         id, product_id, customer_id, order_id, rating, title, body,
                                             author_name, status, version, created_at, moderated_at
                                             UNIQUE(product_id, customer_id)
    product-rating.entity.ts                 product_id PK, rating_sum, rating_count, version
    reviews.service.ts                       create (requires a purchase row), edit, list, moderate
    rating-rollup.ts                         pure: (sum, count) -> ratingAvgE2, in BigInt
    reviews.controller.ts                    the public + customer routes
    moderation.controller.ts                 the staff routes (M16 debt)
    users.client.ts                          GET /users/:id for author_name at create time — the
                                             M10 pattern (orders -> users), 503 not 400 on failure
  src/events/
    order-events.listener.ts                 order.confirmed -> purchases rows (handleOnce + UNIQUE,
                                             the shipping belt-and-braces)

apps/search-service/
  products.index.ts                          + ratingAvgE2 (integer), ratingCount (integer), ratingVersion (long)
  product-document.ts                        unchanged — product events never carry ratings
  products.projection.ts                     upsert() -> scripted _update (§5 A); + applyRating()
  events/catalog-events.listener.ts          + product.rating_changed (bind `product.*` already covers it)
  search-query.ts                            + sort=rating_desc; hits carry ratingAvgE2/ratingCount
  admin.controller.ts                        recreate-index response: next = republish on BOTH sides

apps/reviews-service  POST /reviews/admin/republish     re-emit product.rating_changed for every row —
                                                        the write side owns replay, for every write side

storefront/
  app/products/[slug]/page.tsx               stars + count; approved reviews list; write/edit form
                                             (shown only when the API says the customer may)
  app/search/SearchResults.tsx               stars on hits; "Top rated" in the sort select
  e2e/reviews.spec.ts

docker-compose.yml                           reviews-service (Postgres shape: depends on rabbitmq;
                                             no redis; 90 s start_period)
scripts/gen-api-spec.sh                      [reviews]=3010;  root build:all / test:all; CI install + tsc
```

### The API

```
GET  /reviews/products/:productId?page=&limit=    public; approved only; newest first
GET  /reviews/products/:productId/eligibility     auth; { canReview, reason, existing?: reviewId }
POST /reviews/products/:productId                 auth; { rating, title, body } -> 201 pending
                                                  403 if no purchase row; 409 if one exists (use PATCH)
PATCH /reviews/:id                                auth, owner only; returns to pending
GET  /reviews/me                                  auth
GET  /reviews/moderation?status=pending           staff-by-name (M16)
POST /reviews/:id/approve | /reject               staff-by-name (M16); 409 on an illegal transition
POST /reviews/admin/republish                     staff-by-name (M16)
```

Gateway: `GET /reviews/products/*` joins the public `@Get` list beside
catalog and search; everything else falls through to the guarded `@All`.

### `author_name`

A review shows a name. The gateway forwards a user id and a role, not a
name; the browser cannot be trusted to supply one. So `create` calls
`GET /users/:id` on users-service and **snapshots `name`** onto the review —
the way orders reads an address in M10 — and a users-service outage is a
503, not a 400. A later name change does not rewrite old reviews; that is
the point of a snapshot.

---

## 7. Storefront

- **Product page:** average as stars with the count ("4.4 · 12 reviews"),
  the approved reviews below, newest first. Signed in and eligible: a form.
  Signed in and not eligible: one line saying why ("Only customers who
  bought this can review it" / "You reviewed this — edit"). Signed out:
  nothing.
- **Search hits:** stars and count when `ratingCount > 0`; nothing when 0.
  `sort=rating_desc` as "Top rated".
- **Eventual consistency, again:** a review approved a moment ago shows on
  the product page (reviews-service, direct read) before the star average
  on the search hit catches up (projection). Seconds. Say nothing; it is
  the same window M12 documented, and the product page is the truth.
- **No moderation UI.** That is M17's admin app. M13 verifies moderation
  with `curl`.

---

## 8. Verification

**Unit, no database, no cluster:**

- `rating-rollup.ts`: (0,0) → 0 / null; (9,2) → 450; (13,3) → 433 (433.33
  rounds down); (14,3) → 467 (466.67 rounds up); (7,2) → 350 exactly;
  BigInt path for a sum past `MAX_SAFE_INTEGER / 100`.
- The review state machine: every legal transition and every illegal one
  (approve an approved → 409; reject a rejected → 409).
- search: the product script leaves `rating*` alone; the rating script
  leaves everything else alone; each returns `noop` on a stale version.

**Against the live stack — the acceptance criteria and the projection:**

- **Buy, then review:** confirm an order for a mug; `POST /reviews/products/:mug`
  → 201. Same customer, a product they did not buy → **403**. This is the
  first claim.
- **Approve → average updates:** approve it; poll
  `GET /search/products?q=mug` until the hit shows `ratingAvgE2`; record the
  latency. This is the second claim.
- **The collision, both directions:** edit the mug's *price* in catalog →
  the hit shows the new price **and still the rating**. Approve a second
  review → the hit shows the new average **and still the new price**.
- **M12's three proofs, re-run** (redelivery, republication, v−1 after v)
  against the scripted upsert — mandatory if §5 A is taken.
- **Rating proofs, same shape:** redeliver `product.rating_changed`; deliver
  a stale rating version after a newer one → unchanged.
- **Reject → average drops**, and the review disappears from the product
  page.
- **Replay of `order.confirmed`** (same id; new id) → one purchase row.
- **Delete-and-rebuild, both sides:** recreate-index → republish (catalog) →
  republish (reviews) → identical search results including ratings. The
  index now needs both write sides to come back; prove it needs both by
  running only one and showing which fields are missing.
- **users-service down during `POST /reviews`** → 503, review not created.

---

## 9. Definition of Done

- [ ] `order.confirmed` carries `items[]`; shipping-service unaffected (its consumer ignores them)
- [ ] `reviews-service` on 3010, own Neon db, outbox + `processed_events`, migrations tested on a throwaway first
- [ ] `order.confirmed` → `purchases`; replayed event (same id / new id) → one row
- [ ] **Only customers who bought can review**: 201 for a purchase, 403 without
- [ ] One review per customer per product; edit returns it to `pending`
- [ ] Moderation: `approve` / `reject` with a status guard; illegal transition → 409
- [ ] `product_ratings` updated in the moderation transaction; `product.rating_changed` full-state + versioned; `ratingAvgE2` integer, BigInt, round-half-up
- [ ] search: `ratingAvgE2` / `ratingCount` / `ratingVersion` on the mapping; rating projection guarded by its own clock
- [ ] **A product edit does not wipe the rating; a rating change does not wipe the product** — proved both directions
- [ ] M12's three no-op proofs re-run green on the new upsert (if §5 A)
- [ ] **Average rating updates on publish** — latency recorded
- [ ] `sort=rating_desc`; stars on hits and on the product page; eligibility-driven form
- [ ] `POST /reviews/admin/republish`; delete-and-rebuild with **both** republishes → identical
- [ ] `author_name` snapshotted from users-service; 503 when it is down
- [ ] gateway public list, `gen-api-spec.sh`, `build:all`, `test:all`, CI, `docker-compose.yml`
- [ ] `lint`, `test:all`, `gen:spec` + `gen:types`, `scan-secrets.sh` green; storefront lint still exactly 1 problem
- [ ] Playwright: buy → review → (approve via API) → stars on the product page and in search
- [ ] **ADR-0012** (verified purchase as event-derived authorisation; the rollup as a second clock on one document; the write side owns replay, for every write side) and an **amendment to ADR-0011** if §5 A moves the guard into a script
- [ ] Corrections into `IMPLEMENTATION_PLAN.md` §4; HANDOFF updated; M16's list gains the four staff-by-name routes

---

## 10. Before starting

1. **Decide §3** — items on `order.confirmed` (recommended) or a second consumer of `order.created`.
2. **Decide §5** — scripted `_update` with re-proofs (recommended) or a separate ratings index without `sort=rating`.
3. **Provision a Neon project** `reviews_db` (the database inside is `neondb`, HANDOFF §5), and put its string in `apps/reviews-service/.env`. A ninth Neon project — check the account's limit; HANDOFF §4 says "5 projects" for the free tier and there are already eight databases, so this may already be on a paid plan or may need consolidation. **Find out before step 2.**
4. **Roll the Stripe test secret key** — HANDOFF §9. Six milestones have deferred it.
5. The stack must be up for any live step; **check `docker compose ps` first** — Docker Desktop died twice during M12.

---

## 11. Suggested order of work

One commit per step. Steps 1–5 are the milestone; 6–7 are the finish.

1. **`order.confirmed` carries items** — one field, the payload interface,
   shipping's listener typed to ignore it. Prove shipping still creates a
   shipment. Small, and it unblocks everything.
2. **Scaffold reviews-service** — Neon, migrations on a throwaway, outbox +
   `processed_events`, compose, `/ready`, `order.confirmed` → `purchases`
   with the replay proofs. No review API yet.
3. **Reviews and moderation** — entities, the state machine, the eligibility
   rule (403), `author_name` via users-service, `product_ratings` in the
   same transaction, `product.rating_changed` emitted. Unit tests for the
   rollup arithmetic and the transitions. This is the first acceptance
   claim.
4. **The second projection** — mapping change, scripted upsert (§5 A),
   `applyRating()`, **re-run M12's three proofs**, then the collision proofs
   both ways, then the rating no-op proofs. This is the CQRS content of M13;
   if time runs short, stop after this and the lesson is still there.
5. **Replay on both sides** — `POST /reviews/admin/republish`; recreate →
   both republishes → identical; prove the index needs both.
6. **Query and storefront** — `sort=rating_desc`, stars on hits and the
   product page, the eligibility-driven form, Playwright.
7. **ADR-0012, the ADR-0011 amendment, plan corrections, HANDOFF.**
