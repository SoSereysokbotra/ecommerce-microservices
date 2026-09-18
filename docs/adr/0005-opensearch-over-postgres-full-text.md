# ADR-0005 — OpenSearch for the search read model, not Postgres full-text

**Date:** 2026-09-18 (number reserved since M0; written at M12)
**Status:** Accepted
**Milestone:** M12

## Context

M12 is the first read model in the project: a store that is never written by
a request, only by consuming events, and that can be deleted and rebuilt from
them. `PROJECT_PLAN.md` reserved this ADR number for the choice of store in
M0 and noted that "Postgres full-text is simpler but teaches less".

Two options were live when M12 started:

1. **Postgres full-text** — a `tsvector` column with a GIN index in a
   search-service database. One more Neon project, the same TypeORM wiring
   as every other service, `processed_events` for idempotency as everywhere
   else. The query is `to_tsquery` with `ts_rank`; facets are a `GROUP BY`.
2. **OpenSearch**, single node — a JVM in the compose file, the official
   Node client, external versioning for idempotency, `terms` aggregations
   for facets, `multi_match` with fuzziness for relevance.

The machine this runs on has a 7.6 GB Docker VM and eleven containers, and
`HANDOFF.md` §5 records Docker Desktop dying whenever the laptop sleeps.

## Decision

**OpenSearch, single node, security plugin disabled, heap pinned to 512 MB.**

## Why

**It is a genuinely different store, and that is the lesson.** Every service
so far has one Postgres that is both written and read. A projection into a
second Postgres would work, but the reader would be hard-pressed to say what
was different about it — it would look like a second table with extra
steps. A store with a different data model, a different consistency model
and a different idempotency mechanism makes the CQRS split visible.

**External versioning removes the need for a database at all.** This was
not anticipated when the option was framed; it fell out of reading the
OpenSearch write API. `version_type: external` makes every write
conditional on the version being newer than what is stored, which covers
redelivery, republication *and reordering* in one mechanism the store
enforces. Postgres full-text would have needed `processed_events` (a table,
a transaction, a Neon project) and would still not have covered reordering
without a hand-written `WHERE version < $1`. ADR-0011 has the detail;
search-service has **no `DATABASE_URL`**, and `docker compose config` is the
proof.

**Faceting and relevance are what a search page is made of.** A `terms`
aggregation with a `post_filter` gives "the count you would get by clicking
it" in one query; `multi_match` with `name^3` and `fuzziness: AUTO:4,7`
gives typo tolerance that `to_tsquery` does not. Both were exercised in
step 4 and both found a real bug (plain `AUTO` matched "tee" to "ten").

**The plan chose it and reserved this number for it.** Reversing a recorded
decision needs a reason; "simpler" is not one when simple is the thing the
milestone is trying not to be.

## Cost, measured

- **Memory:** ~970 MB resident for the OpenSearch container with a 512 MB
  heap, on top of the existing stack. It fit; the stack did not thrash.
- **Boot:** ~40 s to first `/_cluster/health` answer. The healthcheck has a
  90 s `start_period` and search-service's `/ready` retries the index
  bootstrap until the cluster is up, so a boot that races the JVM recovers
  without a restart.
- **Docker Desktop died twice during M12** (steps 3 and 5), as it had during
  M10 and M11. OpenSearch did not make it worse, and did not make it better.
  The recovery recipe in `HANDOFF.md` §5 takes about 20 s.
- **One new dependency** (`@opensearch-project/opensearch`) and one new
  image. No new managed service — nothing else in the project runs a
  database in compose, and this does not either: the index is rebuildable
  from catalog's events, so losing the volume loses nothing.

## The fallback, still open

If OpenSearch ever proves unworkable on the machine at hand: Postgres
full-text in a search-service database. The projection in ADR-0011 survives
the swap with one change — the version guard becomes `WHERE version < $1`
on the upsert instead of `version_type: external`. The query and facet
code would be rewritten; the CQRS shape would not. `docs/M12_SEARCH_PLAN.md`
§5 says the same and is the reference.

## Consequences

- A **twelfth container**. `deploy/railway/` has no config for it, and a
  managed OpenSearch is the first thing a real deployment would have to buy.
- **Search shows base-currency prices** (`priceMinor` + `exponent` on the
  document) and never converts — the cart is where a number becomes
  binding (ADR-0010). Converting search results would mean a quote per hit.
- **The mapping is `dynamic: strict`.** An unmapped field on an event fails
  the write rather than inventing a type. Changing a field's type is a
  reindex: `POST /search/admin/recreate-index` then
  `POST /catalog/admin/republish`.
- **Stock and ratings are not in the index.** M13 projects a rating rollup
  onto it; stock stays a live read from inventory, as on the product grid.
