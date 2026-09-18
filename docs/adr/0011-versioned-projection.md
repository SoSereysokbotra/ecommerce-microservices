# ADR-0011 — A versioned projection with no read-side database, and replay owned by the write side

**Date:** 2026-09-18
**Status:** Accepted
**Milestone:** M12

## Context

M12 builds the first read model: an OpenSearch index of products, fed by
catalog's events over RabbitMQ, that can be deleted and rebuilt from those
events with no loss. The acceptance criterion in `PROJECT_PLAN.md` §9 is two
claims — *a product edit appears in search within seconds* (a latency) and
*with no shared database* (an absence).

Three things had to be decided before the first line:

1. catalog-service **emitted nothing**. It was the last service shaped the
   way M0 built it — no outbox, no `RabbitMQModule`, no version on its rows.
2. Every consumer so far has used **`processed_events`** to make redelivery
   safe: a marker written in the same transaction as the effect. That needs
   a relational store, which means a ninth Neon database for search.
3. The plan asks for a **reindex** command. A read side that rebuilt itself
   by walking catalog's tables would be a read side with a shared database —
   the exact thing the criterion forbids.

## Decision 1 — Events carry full state and a version; catalog gets a real version guard

`product.created` / `product.updated` / `category.updated` carry the **entire
row**, not a diff, plus `version`. A consumer writes a document from one
event with no join and no prior state, which is what makes a from-scratch
rebuild possible. There is no `product.deleted`: catalog sets `active:
false` and the event carries the flag.

The version column arrived with a finding. TypeORM's `@VersionColumn`
increments on `save()` but **does not check** — the SQL is `UPDATE … SET
version = version + 1 WHERE id = $1`, with no `AND version = $2`. A
collision test with two editors reading v4 showed the second silently
winning. `ProductsService.update()` and `CategoriesService.update()` are
therefore hand-written conditional UPDATEs, the M9 coupon pattern, and the
outbox row is appended in the same transaction. Catalog's version is both
the projection's ordering key and the write side's optimistic lock; the
projection's need is what exposed that the lock was never there.

## Decision 2 — Versioned writes instead of `processed_events`; no read-side database

Every write to the index is
`index({ id, version: event.version, version_type: 'external', body })`.
OpenSearch accepts it only if the version is **greater** than what is
stored. That one rule, enforced by the store, handles three failures that
have different names:

| Delivery | Stored | Incoming | Result |
|---|---|---|---|
| first time | — | 7 | written |
| same event redelivered | 7 | 7 | **409**, treated as done |
| republished under a **new** event id | 7 | 7 | 409, same |
| **v6 arriving after v7** | 7 | 6 | 409 — the stale one loses |

All four rows were run live in step 3 (HANDOFF §6): the same
`product.updated` redelivered, republished with a new id, and a v−1
injected after v — the document did not move — and then a control v+1,
which landed, proving the three rejections were the guard and not a dead
consumer.

The last row is the one `processed_events` **cannot** pass. A marker says
"I have seen this event id"; it has no opinion about whether a *newer* event
has already been applied. Ordering is the correctness problem specific to
projections — the bus delivers at least once and in no guaranteed order —
and a version is its answer.

So search-service has **OpenSearch and RabbitMQ and nothing else**. No
`TypeOrmModule`, no `@libs/outbox`, no `typeorm` or `pg` in its
`package.json`, no `DATABASE_URL` in its compose block. `docker compose
config search-service` is the proof of the criterion's second half, and the
block looks different from every other service's because the difference is
the point. A ninth Neon database would have bought a second guard the first
already covers, and could not have covered reordering anyway.

**A 409 is success.** `ProductsProjection.upsert()` returns `'stale'` and
logs at debug; it never throws on a conflict. Rethrowing would nack the
message with `requeue=false` (M18 adds a dead-letter queue) and the bus
would drop an event that was never wrong.

## Decision 3 — The write side owns replay

The read side cannot rebuild itself: walking catalog's tables is the rule
being enforced, and catalog's outbox is a **delivery queue, not a retained
log** — rows are marked published and are not a history. So the reindex is
two commands on two sides:

```
POST /search/admin/recreate-index    drop the index, create it empty with the mapping
POST /catalog/admin/republish        append product.updated / category.updated for
                                     every row, at its CURRENT version
```

Because every consumer write is versioned, republish is **safe against a
live index**: a republished v7 is a 409 against a stored v7 or v8. Run
without recreating first, it changes nothing — measured: 13 × `stale`, five
queries identical. Run after recreating, it rebuilds: measured **12 active
documents back in 2.41 s, five queries byte-identical** to the snapshot
taken before the index was dropped. That measurement is the milestone.

Republish emits the *current* version and never resets it. A "fresh" v1
would be *older* than what the index holds and would be refused.

## Decision 4 — Denormalised category fields, fanned out with the guard in the query

Each product document carries `categorySlug`, `categoryName` and
`categoryVersion`, because faceting and display need them without a join.
A category rename therefore has to touch every product in it — the classic
projection fan-out. It is one `_update_by_query`:

```
filter:  categoryId = X  AND  categoryVersion < event.version
script:  set categorySlug, categoryName, categoryVersion
```

`_update_by_query` has no external versioning, so the guard is expressed as
a **range in the filter**: a stale rename matches zero documents and is a
no-op by construction. Measured: Apparel → Clothing reached 6 of 6 products
and the facet in 2.54 s; a stale v1 injected afterwards changed nothing;
redelivery updated 0.

Two things the fan-out deliberately does not do. It does not touch the
product's own `version` — that is the product's clock, `categoryVersion`
is the category's, and one document carries both. And it runs with
`conflicts: 'proceed'`: a product being rewritten by its own event at the
same instant is skipped, because that event carries the current category
name itself.

The category **slug is immutable** (`PATCH /catalog/categories/:id` takes
name and description only). It is the facet key, the value on every
document and a URL; renaming changes what a category is called, not what
it is — the same rule as `sku`.

## Things learned that are not decisions

- **Deleting a document does not reset its version.** A `DELETE` is a
  versioned write; the tombstone carries v+1 and lives for
  `index.gc_deletes` (60 s). After a proof left a fabricated v3 in the
  index, deleting it and letting catalog emit real v3 and v4 saw both
  refused; v5 landed. The only reset is dropping the index.
- **Plain `fuzziness: AUTO` matches "tee" to "ten".** One edit is allowed
  from three letters. `AUTO:4,7` — exact below four letters — fixed it and
  still finds "hoodei".
- **The category filter must be a `post_filter`.** In `query` it collapses
  the facet to the selected category the moment anyone clicks one.
- **`dynamic: strict`** on the mapping turned out to be free: the
  projection is an explicit function from event to document, so nothing
  legitimate is dynamic, and an unmapped field now fails loudly.
- **The exponent is a constant (2)** on the document. Catalog has no
  `currencies` table and its prices are in the base currency; the index
  does not convert (ADR-0010). One line to change if the base ever does.

## Consequences

- **Search is eventually consistent, and the storefront says so.** A hit
  can 404 on click for a product deactivated a moment ago; the product page
  explains that rather than crashing. The window measured 0.85–2.54 s.
- **`processed_events` stays the pattern for services with a database.**
  This ADR does not replace it; it records when a versioned write is
  enough and when it is more.
- **Every M12 admin endpoint is staff-only in name only** until M16:
  `republish`, `recreate-index`, `PATCH /catalog/categories/:id`. Any
  valid JWT can empty the search index today. Listed in `HANDOFF.md` §9.
- **A fresh clone's index is empty until republished.** The seed does not
  go through the outbox. `HANDOFF.md` §4 has the step; folding it into
  `setup.sh` belongs with M22.
- **There is still no category create API.** `category.created` is bound
  and handled as a no-op — nothing can be in a category that did not exist
  a moment ago.

## Figures, all measured live

| | |
|---|---|
| Edit → raw document in the index | 0.85 s (later edits 0.23–0.46 s) |
| Edit → visible via `GET /search/products` through the gateway | **1.21 s** |
| Deactivate → gone from results | 0.95 s |
| Recreate + republish → 12 documents back, 5 queries identical | **2.41 s** |
| Rename → 6 of 6 products and the facet | 2.54 s |
| Redelivery, republication, reordering, stale rename | no change, every time |
