# M12 — Search: implementation plan

**Written:** 2026-09-16
**Status:** Draft, for review. Nothing built yet.
**Milestone:** M12, first of R3

Read §3, §4 and §5 before agreeing to this.

- **§3 is a gap.** The plan says the index is built "from catalog events".
  **catalog-service emits no events.** It has no outbox and no RabbitMQ module —
  it is the only service still shaped the way M0 built it. M12 starts by fixing
  that, and the fix also closes a latent bug.
- **§4 is the design.** Search-service needs **no Postgres at all** — no ninth
  Neon database — because a versioned projection is idempotent by construction.
  That is the CQRS lesson stated as an architecture, not a slogan.
- **§5 is the operational cost.** OpenSearch is a JVM that wants a gigabyte,
  on a machine whose Docker Desktop already dies when the laptop sleeps. I
  recommend it anyway, because it is the choice the plan made and the one that
  teaches something, but the fallback is stated.

---

## 1. What M12 is for

`PROJECT_PLAN.md` §7 calls R3 "read models and event-driven projections — the
CQRS lesson". Everything before this has had one store per service that is both
written and read. M12 builds the first **read model**: a store that is never
written by a request, only by consuming events, and that can be **deleted and
rebuilt** from those events with no loss.

That last property is the test. A read model you cannot throw away is just a
second database with extra steps.

The acceptance criterion from `PROJECT_PLAN.md` §9:

> Product edit appears in search within seconds, with no shared database.

Two claims, both checkable: a latency, and an absence. The absence is the
important one — search-service must reach catalog's data **only** through the
bus, and the compose file should make that obvious by giving it no database
connection string of any kind.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| New service | `search-service`, port **3009** | Reserved in `IMPLEMENTATION_PLAN.md` Appendix B. |
| Store | **OpenSearch**, single node | `PROJECT_PLAN.md` Appendix: "Postgres full-text is simpler but teaches less". ADR-0005 is reserved for exactly this decision. §5 has the caveat. |
| Fed by | catalog's events, over RabbitMQ | The plan entry. Never a read of catalog's database. |
| Reindex | A command on the **write** side | See §4. The read side cannot rebuild itself without reading a database it must not read. |
| Idempotency | Versioned writes | See §4. No `processed_events` table, because none is needed. |
| Scope | Products and categories | Stock and ratings are later projections — M13 explicitly says "rating rollup projected onto the search index". Indexing inventory now would be for an imagined future. |

---

## 3. The gap: catalog emits nothing

```
$ grep -rl "outbox\|RabbitMQ" apps/catalog-service/src
(nothing)
```

catalog-service has no outbox, no `RabbitMQModule`, no `processed_events`. Every
other backend service acquired the wiring at the milestone that needed it — cart
in M7, pricing in M9, shipping in M10. Catalog never had a reason. Now it does.

### What catalog will emit

```
product.created     full product state + version
product.updated     full product state + version
category.created    full category state + version
category.updated    full category state + version
```

**Full state, not a diff.** A consumer building a projection must be able to
write the document from one event without joining anything. A `product.updated`
carrying only the changed fields would force the read side to already have the
rest — which it might not, if it is being rebuilt from scratch.

There is no `product.deleted`. Catalog does not delete; it sets `active: false`,
and the event carries that flag. The read side removes inactive products from
results, or keeps them and filters — either way it is a field, not a tombstone.

### The latent bug this fixes

Events need a **version**, and catalog has none. TypeORM's `@VersionColumn`
provides one — and it also provides optimistic locking, which catalog currently
lacks entirely. Two staff editing the same product at once today produce a lost
update, silently. M8 found exactly this class of bug in inventory. Adding the
version for the projection's sake closes it as a side effect, and that is worth
saying in the ADR rather than discovering later.

---

## 4. A read model with no database of its own

### Why search-service needs no Postgres

Every consumer so far has used `processed_events` to make redelivery safe: the
marker and the effect share one transaction. That needs a relational store.

A projection into OpenSearch does not, **if writes are versioned**. OpenSearch
supports external versioning natively: `PUT /products/_doc/{id}?version=7&version_type=external`
succeeds only if 7 is greater than the stored version. So:

| Delivery | Stored version | Incoming | Result |
|---|---|---|---|
| first | — | 7 | written |
| same event redelivered | 7 | 7 | **rejected (409)** — treated as success |
| republished with a new event id | 7 | 7 | rejected — same |
| **out of order**: v6 arrives after v7 | 7 | 6 | rejected — the stale one loses |

One mechanism handles redelivery, republication *and* reordering, and the
store enforces it rather than application code. That last row is the one
`processed_events` cannot handle at all: a marker says "seen this event", not
"seen a newer one". Ordering is the correctness problem specific to
projections, and versioning is its answer.

So search-service has **OpenSearch and RabbitMQ, and nothing else**. No
`DATABASE_URL`. No ninth Neon database — which, after M10's provisioning
detour, is not a small thing. Its compose block will look different from every
other service's, and the difference is the point.

**If you would rather it have `processed_events` anyway**, for consistency with
the other consumers, say so — it costs a Neon database and buys a second guard
that the first already covers.

### Reindex from scratch, without reading catalog's database

The plan asks for a reindex command. The read side cannot walk catalog's
tables — that is the rule. So the command lives on the **write side**:

```
POST /catalog/admin/republish        walks products and categories, appends a
                                     product.updated / category.updated for each
                                     to the outbox, at its current version
```

The read side then rebuilds by consuming, exactly as it does for live changes.
The full reindex is: delete the OpenSearch index, recreate it with the mapping,
call republish. Versioned writes make it safe to run against a live index too —
a republished v7 cannot overwrite a v8 that arrived in the meantime.

This is the standard shape and it is worth naming: **the write side owns
replay.** An event log that could be replayed from the outbox table would also
work, but catalog's outbox is a delivery queue, not a retained log, and treating
it as one would be a second design decision for no gain.

`POST /catalog/admin/*` is a staff action with no roles until M16 — same debt
as dispatch/deliver in M10, one more entry on the pile.

### Category renames: the denormalisation cost

The index stores `categorySlug` and `categoryName` on each product document,
because that is what faceting and display need. A category rename therefore has
to touch every product in it. OpenSearch's `_update_by_query` does that in one
call, guarded by the category version so a stale rename cannot overwrite a newer
one. It is the classic projection fan-out, and it is cheap here because
categories are three rows that change once a year.

---

## 5. OpenSearch — what it costs on this machine

A single-node OpenSearch with security disabled and a 512 MB heap wants roughly
a gigabyte of resident memory. The Docker VM has 7.6 GB and eleven containers
already. It fits. But `HANDOFF.md` §5 records Docker Desktop dying when the
laptop sleeps, and it died **six times** during M10 and M11 — a heavier VM will
not help.

**Recommendation: OpenSearch, pinned to `-Xms512m -Xmx512m`, with a
healthcheck and a `start_period` long enough for a JVM.** The plan chose it and
reserved ADR-0005 for the choice; faceting, relevance scoring and a genuinely
different store are what make this a CQRS milestone rather than a second table.

**The fallback**, if it proves unworkable: Postgres full-text (`tsvector` +
GIN) in a search-service database. The projection design in §4 survives that
swap unchanged except for the versioning, which would become a `WHERE version <
$1` on the upsert. It teaches less about search and exactly as much about CQRS.

---

## 6. Shape of the changes

```
apps/catalog-service/                       ** gains events **
  src/events/                                outbox relay (libs/outbox), as every other service
  src/modules/products/product.entity.ts     @VersionColumn
  src/modules/categories/category.entity.ts  @VersionColumn
  src/modules/admin/republish.controller.ts  POST /catalog/admin/republish
  migrations                                 outbox tables; version columns

apps/search-service/                        ** NEW — port 3009, NO Postgres **
  src/
    modules/search/
      opensearch.client.ts                   thin wrapper; index + mapping bootstrap
      product-document.ts                    the projection shape, one function from event to doc
      search.service.ts                      query, facets, pagination
      search.controller.ts                   GET /search/products
      admin.controller.ts                    POST /search/admin/recreate-index
    events/
      catalog-events.listener.ts             product.* / category.* -> versioned upserts

storefront/                                  search box; /search results page with facets
docker-compose.yml                           opensearch (512m heap) + search-service
scripts/gen-api-spec.sh                      [search]=3009
```

### The document

```
products index, one document per product:
  id, sku, slug, name, description
  priceMinor, currency, exponent (2 — the base currency's, until §7 below)
  categoryId, categorySlug, categoryName, categoryVersion
  active, weightGrams
  version                                    external versioning key
  updatedAt

mapping:
  name          text, with a keyword sub-field for exact match and sorting
  description   text
  sku, slug     keyword
  categorySlug  keyword                      the facet
  priceMinor    integer                      range filter
  active        boolean
```

**Price in the index is the catalog's base price.** Search shows base-currency
prices exactly as the product grid does after M11 (ADR-0010 recorded that
listings do not convert). Converting search results would mean a quote per hit;
the cart is where the number becomes binding.

### The query

```
GET /search/products?q=tee&category=apparel&minPrice=1000&maxPrice=5000&page=1
  -> { hits: [...], total, facets: { categories: [{ slug, name, count }] } }
```

Only active products, always. Relevance by default; `sort=price_asc|price_desc`
as an option. Facet counts computed over the same filtered set, so the numbers
next to each category are the numbers you will get if you click it.

---

## 7. Storefront

- **A search box in the header.** Submits to `/search?q=`.
- **A results page** with hits, the category facet as clickable filters, and a
  price range. Each hit links to the existing product page, which reads catalog
  directly — so the detail page is always the source of truth even if the index
  is a second behind.
- **Eventual consistency, said out loud.** A product deactivated a moment ago
  can appear in results and 404 on click. That window is seconds and it is
  inherent; the results page handles the 404 gracefully rather than pretending
  the window does not exist.
- The home page keeps its catalog listing. Search is additive.

---

## 8. Verification

**Unit, no database, no OpenSearch:**

- `product-document.ts`: event → document, including an inactive product and a
  product with no category.
- The version guard logic: a 409 from OpenSearch is treated as success and
  logged at debug, not as a failure that nacks the message into a loop.

**Against the live stack — the acceptance criterion, and the CQRS properties:**

- **Edit a product name via `PATCH /catalog/products/:id`; poll
  `GET /search/products?q=<new name>` until it appears; record the latency.**
  This is the plan's acceptance test. Expect low single-digit seconds: outbox
  relay (1 s poll) plus the consumer.
- **Redeliver the same `product.updated`** — document unchanged, 409 logged.
- **Republish with a new event id** — same.
- **Deliver v6 after v7** — the stale one is rejected; the document still says
  v7. This is the test `processed_events` could never pass.
- **Deactivate a product** — gone from results within seconds.
- **Rename a category** — every product in it shows the new name; a stale
  rename delivered afterwards does not revert it.
- **Delete the index, republish, search again** — identical results. The read
  model was thrown away and came back. This is the milestone.
- **`docker compose config`** shows search-service with no `DATABASE_URL`.

---

## 9. Definition of Done

- [ ] catalog-service has an outbox and emits `product.*` / `category.*` with full state and a version
- [ ] `@VersionColumn` on products and categories — optimistic locking proved by a concurrent-update test
- [ ] `search-service` on 3009 with **no Postgres** — the compose block has no database connection
- [ ] OpenSearch single node, 512 MB heap, healthchecked
- [ ] Versioned upserts: redelivery, republication **and reordering** all proved no-ops
- [ ] `GET /search/products` with query, category facet, price range, sort; active only
- [ ] Category rename fans out, version-guarded
- [ ] `POST /catalog/admin/republish` and `POST /search/admin/recreate-index`; **delete-and-rebuild yields identical results**
- [ ] **Product edit visible in search within seconds**, latency recorded
- [ ] Storefront: search box, results page with facets, graceful 404 on a stale hit
- [ ] `gen-api-spec.sh` gains `[search]=3009`; `test:all` and `build:all` gain the service
- [ ] Migrations reversible on a **throwaway Postgres** (catalog's, for the outbox and version columns)
- [ ] `lint`, `test:all`, `gen:spec` + `gen:types`, `scan-secrets.sh` green
- [ ] Playwright: search for a product, filter by category, open a hit
- [ ] **ADR-0005** written at last (OpenSearch over Postgres FTS — reserved since M0) and **ADR-0011** (versioned projection, no read-side database, write-side replay)
- [ ] Correction into `IMPLEMENTATION_PLAN.md` §4

---

## 10. Before starting

1. **Decide §4** — no read-side Postgres (recommended) or a `processed_events`
   table for consistency with the other consumers. This decides whether a Neon
   database is needed.
2. **Decide §5** — OpenSearch (recommended) or Postgres full-text.
3. **Check Docker Desktop's memory allocation** is at least the current 7.6 GB.
   OpenSearch will be the largest container by a wide margin.
4. **Roll the Stripe test secret key** — HANDOFF §9. Still outstanding; four
   milestones have deferred it.
5. No Neon database if §4 is accepted as recommended.

---

## 11. Suggested order of work

One commit per step. Steps 1–4 are the milestone; 5–7 are the finish.

1. **Catalog joins the event system** — outbox tables, `@VersionColumn` on
   both entities, events appended in the same transaction as every write.
   Migrations on a throwaway first. Prove optimistic locking with two concurrent
   updates: one must fail.
2. **Scaffold search-service and OpenSearch** — compose, healthchecks, index
   bootstrap with the mapping, `/ready` that checks the cluster. No consumer
   yet. Verify the compose block has no database.
3. **The projection** — the consumer, versioned upserts, and the three no-op
   proofs (redelivery, republication, **reordering**). This is the CQRS
   content; if time runs short, stop after this and the lesson is still there.
4. **Querying** — `GET /search/products` with facets, range and sort. The
   acceptance test: edit a product, time its appearance.
5. **Republish and recreate** — the write-side replay, the read-side reset, and
   the delete-and-rebuild proof.
6. **Category fan-out** — `_update_by_query`, version-guarded, with the
   stale-rename test.
7. **Storefront, Playwright, ADR-0005 and ADR-0011.**

If OpenSearch proves unworkable on this machine, §5's fallback slots in at step
2 and steps 3–7 are unchanged in substance.
