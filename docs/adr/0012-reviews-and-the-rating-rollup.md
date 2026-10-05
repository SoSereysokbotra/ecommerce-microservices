# ADR-0012 — A right to review derived from an event, and a rating rollup that shares a document with two other owners

**Date:** 2026-10-05
**Status:** Accepted
**Milestone:** M13

## Context

`PROJECT_PLAN.md` §7 asks for two things from M13:

> Only customers who bought can review; average rating updates on publish.

The first is an **authorisation question**: on what basis may someone write a
review? The second is a **projection question**: M12 put one write side's data
into the search index; M13 puts a second write side's data onto the *same
document*, and the two must not overwrite each other.

The reviews themselves are CRUD and are not what this ADR is about.

---

## Decision 1 — The right to review is a fact that arrived on the bus

There is no `can_review` flag, no role, and no endpoint that grants
eligibility. `reviews-service` consumes `order.confirmed` — the saga's
terminal success, emitted in the same transaction as the status change since
M9 — and writes one `purchases` row per line. `POST /reviews` reads that
table; no row, **403**.

**`order.confirmed` had to learn what was bought.** It carried who and how
much, not which products. Adding `items: [{ productId, sku, qty }]` is the
third time this project has put a field on an event because a consumer
genuinely needed it — `order.created` kept its payload in M8 for the
opposite reason, and M10 added the shipping address for this one.

The alternative was to consume `order.created` (which already had items) and
`order.confirmed` together, recording a pending pair on the first and
confirming it on the second. **Rejected:** a cancelled order would leave a row
to clean up on a third event, and the right to review would depend on two
facts arriving in order rather than on one fact being true.

**Two guards, as everywhere.** The bus delivers at least once:
`processed_events` catches a redelivered event id;
`UQ_purchases_customer_product_order` catches a **republished** one carrying a
new id, which the marker cannot see. M9 proved the marker alone insufficient
by testing precisely that case, and shipping-service has used both since M10.

What this buys: the permission cannot be granted by mistake, because nothing
can grant it. It can only be *earned*, and only by an order the saga
confirmed.

---

## Decision 2 — The write side computes the average; nobody else may

`reviews-service` keeps `product_ratings` — `rating_sum`, `rating_count`,
`version` — updated **in the same transaction** as the moderation decision
that changed it, and emits the whole row as `product.rating_changed`.

search-service could not do this if asked: it has no database and cannot
aggregate (ADR-0011). But the rule is stronger than that constraint, and
M13 proved why. The storefront's first version derived the average from the
page of reviews it had on screen — ten items — and displayed it beside the
product's *total* count. A product with ninety reviews would have shown the
average of the newest ten under the label "90 reviews". It was also a second
implementation of a figure that already had an owner, which is the defect
ADR-0007 spent a milestone removing from pricing.

So `GET /reviews/products/:id` carries `rating: { avgE2, count } | null`,
read from the row that owns it. The browser divides by 100 to print it and
does nothing else.

**Integers only.** `rating_sum` and `rating_count` are the stored truth;
the average is derived at emit time as an integer hundredth (437 = 4.37),
round-half-up, in BigInt. ADR-0010's rule is not about currency — it is
about numbers people compare and sort on. A stored `4.37` drifts the moment
it is recomputed from a different direction. Null, not zero, when there are
no approved reviews: zero would be a rating.

**Only `approved` counts.** A review is created `pending` and is invisible.
An edit returns it to `pending` and withdraws its rating. Every transition is
a conditional UPDATE on `status` — zero rows affected means 409, not a silent
no-op — and the rollup moves inside that same transaction.

---

## Decision 3 — Two write sides own disjoint fields of one document, each with its own clock

This is the part M12 did not have to solve.

M12 wrote the whole product document with `index()` and
`version_type: external`. `index` **replaces** the document. The moment
rating fields live on it, any `product.updated` — a price change, a
republish — erases the rating until the next `product.rating_changed`
happens to arrive. A lost update, and this project does not ship those.

The chosen fix (plan §5, option A) is one scripted `_update` per write side,
with `scripted_upsert: true` and `retry_on_conflict: 3`:

```
product event   if (ctx._source.version      >= params.version) noop
                else set every product field   — never touches rating*
rating event    if (ctx._source.ratingVersion >= params.version) noop
                else set ratingAvgE2, ratingCount, ratingVersion
                                               — never touches product fields
```

Three clocks now share one document: the product's `version`, the category's
`categoryVersion` (M12's fan-out), and the rating's `ratingVersion`. Each
write compares only its own and writes only its own fields.

**This moved the guard but not the guarantee** — see the amendment appended
to ADR-0011. The mechanism is no longer `version_type: external`; it is a
comparison in painless, enforced inside the document's compare-and-set.
M12's three proofs were re-run against it and still hold: a redelivered
event, a republished one, and a v−1 arriving after v all leave the document
untouched. The collision was then proved in both directions: editing the
price kept the rating; changing the rating kept the price.

The rejected alternative was a separate `product_ratings` index merged at
query time. It would have left ADR-0011 untouched and cost one extra round
trip per page — but OpenSearch cannot sort on a field in another index, so
`sort=rating_desc` would have been impossible. The fallback remains open and
is confined to `ProductsProjection` and `search.service.ts`.

**A mapping change is a reindex.** The three fields had to be added to a
`dynamic: strict` mapping, so step 4 began with `recreate-index` and a
republish. That is the cost of strictness and it is worth it: an unmapped
field fails loudly instead of inventing a type.

---

## Decision 4 — Replay is owned by every write side, not just the first

M12 established that the write side owns replay: the read side cannot walk
anyone's database. M13 makes the plural explicit. A rebuilt index now needs
**two** commands, and `POST /search/admin/recreate-index` says so in its
response:

```
POST /search/admin/recreate-index     drop, recreate empty
POST /catalog/admin/republish         products come back
POST /reviews/admin/republish         ratings come back
```

Each re-announces its rows **at their stored version** — never resetting it,
which is what makes a republish safe against a live index. Measured: catalog
alone returns 12 products with **0 rated**; reviews then restores the ratings
in 0.32 s and the result is identical to the snapshot taken before the index
was dropped. Running both again against the live index changes nothing.

The generalisation worth keeping: **a read model needs one replay command per
write side that feeds it.** Add a third owner and you add a third command.

---

## Things learned, which are not decisions

- **Raw SQL returns snake_case.** `manager.query(... RETURNING *)` hands back
  `rating_sum`, not `ratingSum`; the TypeScript type parameter is a claim,
  not a conversion. Reading `row.ratingSum` yielded `undefined`, which
  reached the BigInt average as `NaN` and threw — **every approval would
  have 500'd**, while the unit tests passed. Same family as the
  INSERT-vs-UPDATE shape trap in `HANDOFF.md` §5.
- **A mock kinder than the database tests nothing.** Those tests passed only
  because the mock returned entity objects. Making it return snake_case —
  what Postgres actually sends — failed four tests immediately and has been
  the cheapest guard since.
- **A later step can silently undo an earlier one.** `PublicReviewDto`, which
  keeps `customerId` and `orderId` off the public review list, was added in
  step 3, removed when step 5 rewrote the file, and shipped — because that
  commit was verified for its *new* behaviour only. One `curl` at the
  endpoint an earlier step hardened would have caught it.
- **`GET /users/:id` is JWT-guarded** and a service has no token to present.
  Reviews reads the author's name through `GET /users/me` with the
  gateway-set `x-user-id`, which is the pattern `AddressesController`
  established in M10.

---

## Consequences

- **A tenth service with a tenth database.** Unlike search-service, a review
  is state written by a request and cannot be rebuilt from any event — so
  this one genuinely needs Postgres, an outbox and `processed_events`.
- **Three staff-by-name endpoints more** — `POST /reviews/:id/approve`,
  `/reject` and `/admin/republish` — protected by nothing but a valid JWT
  until M16. Listed in `HANDOFF.md` §9 with the rest.
- **Orders placed before step 1 grant nothing.** Their `order.confirmed`
  carried no items, so those customers cannot review. Backfilling a right to
  review from an event that never named the products would be inventing one.
- **The public review list is approved-only and id-free**, by a mapped DTO
  rather than by returning the entity.
- **Eventual consistency is visible here too.** A review approved a moment
  ago appears on the product page (a direct read) before the star average on
  a search hit catches up (a projection). Seconds, and inherent.
- **M14's co-purchase model and M15's notifications both consume
  `order.confirmed`.** It now carries items, which both will want.

## Figures, all measured live

| | |
|---|---|
| Review a product not bought / bought | **403** / 201 `pending`, author snapshotted |
| Second review of the same product | 409 |
| Approve → rollup and event | `sum 4, count 1, version 1`, `ratingAvgE2: 400` published |
| Approve again | **409** — the status guard |
| M12's three no-op proofs on the scripted upsert | all unchanged |
| Product edit after a rating | price 1400 → 1407, **rating kept** |
| Rating change after an edit | avg → 467, **price kept** |
| recreate → catalog republish only | 12 products, **0 rated** |
| → then reviews republish | 1 rated in **0.32 s**, identical to before |
