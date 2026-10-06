# M14 — Recommendations: implementation plan

**Written:** 2026-10-06
**Status:** Reviewed 2026-10-06. The three §14 questions are settled — **Option A** (a separate `recommendations-service`), a **dedicated replay event**, and **no minimum count**. See §5, §7 and §14.
**Milestone:** M14, third of R3

Read §3, §4 and §5 before agreeing to this. Each represents a significant architectural decision with real trade-offs and alternatives:

- **§3 is the event correction and the payoff.** The plan asks to consume `order.paid`. There is no such event; `order.confirmed` is the fact, and since M13 it carries `items[]`. Recommendations becomes the third consumer of that event, proving the value of M9's "leaf event" design.
- **§4 is the idempotency lesson.** M12 and M13 used versioned state documents where replay is naturally idempotent: writing `version 7, price 1407` twice is a no-op. A co-purchase counter is an accumulator: `+1` applied twice is permanently wrong and undetectable. The M12 OpenSearch trick cannot work here; recommendations requires transactional event deduplication (`processed_events`).
- **§5 is the service location.** A standalone service with its own Neon database costs an 11th service, a 10th database (near or exceeding Neon free-tier limits), and another container in an already strained Docker environment. A module inside `catalog-service` costs nothing in infrastructure but changes catalog's boundaries. A second index in OpenSearch cannot support transactional deduplication.
- **§6 is the pair topology.** Whether baskets produce symmetric directed pairs `(A, B)` and `(B, A)` or canonical undirected pairs `(A, B)` with `A < B`, and how single-item baskets are handled.
- **§7 is the replay dilemma.** In M12/M13, the write side owned replay by walking its own state. Orders-service's outbox is a delivery queue, not an event store. Rebuilding recommendations requires either orders-service emitting replay events (risking duplicate delivery to other consumers) or accepting that historical co-purchases cannot be re-projected from scratch without a dedicated replay channel.

---

## 1. What M14 is for

`IMPLEMENTATION_PLAN.md` §4:

> Co-purchase pairs computed from `order.paid` events.
> **Acceptance:** "Customers also bought" on product pages.

`PROJECT_PLAN.md` §7:

> recommendations-service; "customers who bought X also bought Y" co-purchase graph
> computed from order events. **Acceptance:** "Customers also bought" section on
> product pages updates after purchases.

This is the second read model in R3. M12 proved CQRS for document search (full-state projection, versioned upsert, no database). M13 added a second write side and an event-derived authorization. M14 adds an **accumulating projection**: an association graph derived from terminal commerce facts.

Unlike search, this read model does not mirror single-entity state; it computes relationships across distinct entities from an event stream.

---

## 2. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Consuming event | `order.confirmed`, not `order.paid` | There is no `order.paid` event. `order.confirmed` is the saga's terminal success, emitted in the same transaction as the status change. |
| Event payload | `items: [{ productId, sku, qty }]` | Added in M13 step 1 for reviews; recommendations is the consumer that justifies keeping it. |
| Co-purchase definition | Co-occurrence in the same confirmed order | Quantity is ignored: buying 3 mugs and 1 tee is 1 co-purchase occurrence of `{mug, tee}`, not 3. |
| Single-item orders | Ignored (no-op ack) | A basket with 1 item produces 0 pairs. It must still be marked in `processed_events` to prevent reprocessing on redelivery. |
| Ordering of pair | Distinct product IDs only | Buying 2 of the same item does not pair the product with itself. Self-pairs `(A, A)` are discarded. |
| Currency / money | Completely unconcerned | Recommendations cares only about product IDs and co-occurrence frequency. |
| Storefront rendering | Reuses `components/Stars.tsx` | Recommended cards on product pages show thumbnail/name, base price, and star rating. |

---

## 3. The gap: `order.paid` does not exist, and M9's leaf event pays off

### The missing event

`IMPLEMENTATION_PLAN.md` §4 specifies:
```
Co-purchase pairs computed from order.paid events.
```

As discovered in M10 (shipping) and M13 (reviews), **there is no `order.paid` event, and never has been**.

When Stripe authorizes a charge, payments-service emits `payment.authorized`. The saga orchestrator consumes that, requests inventory commit, and upon receiving `inventory.committed`, transitions the order status to `CONFIRMED` while atomically appending **`order.confirmed`** to the outbox.

`order.confirmed` is the definitive domain fact meaning: *this transaction succeeded, stock was deducted, money was captured, and goods are committed to the customer*.

### The third consumer of M9's leaf event

In M9 (coupons), `order.confirmed` and `order.cancelled` were introduced as **leaf events**. The saga orchestrator never consumes them; nothing drives the forward progress of the saga from them. They were created purely so external boundaries could react to terminal order outcomes.

- **M10 (shipping)** consumed `order.confirmed` to generate shipments.
- **M13 (reviews)** consumed `order.confirmed` to populate the `purchases` table for verified purchase authorization.
- **M14 (recommendations)** now becomes the **third consumer** of `order.confirmed`.
- **M15 (notifications)** will be the fourth.

This demonstrates the core payoff of event-driven architecture: four independent capabilities (fulfilment, reputation, discovery/recommendations, communication) attach to the exact same business milestone without modifying `order-saga.service.ts` or adding HTTP couplings to orders-service.

---

## 4. The idempotency lesson: why the M12/M13 versioning trick cannot work here

This is the central conceptual content of M14.

### The M12 / M13 trick

In M12 and M13, search-service achieved idempotency **without a relational database or `processed_events` table**:

```
product.updated (version: 7, price: 1407)
rating.changed  (version: 3, avgE2: 450)
```

Because each event carries **full state and a monotonic clock (`version`)**, writes are idempotent by definition:
- Applying version 7 twice yields version 7.
- Applying a stale version 6 after version 7 is rejected by the store's compare-and-set (`ctx._source.version >= params.version`).
- The operation is a **replacement of state**, not an accumulation.

### Why accumulation breaks versioning

A co-purchase relationship is not entity state. It is an **increment counter**:

$$\text{count}_{A, B} \leftarrow \text{count}_{A, B} + 1$$

There is no natural aggregate version clock attached to a pair of products across the entire customer base. If the message broker redelivers `order.confirmed` for order `ord-123`:

- In a versioned model: the store sees `version <= current` and rejects it.
- In a naive counter: `UPDATE co_purchases SET count = count + 1` executes again.

The count becomes 2 instead of 1. The error is permanent, silent, and undetectable by any schema constraint.

### The requirement: transactional deduplication

Because an increment is not inherently idempotent, idempotency **must be enforced externally**:

1. Every incoming event must be checked against a record of previously handled event IDs (`processed_events`).
2. The check, the record insertion, and the pair counter increment **must occur in the exact same database transaction**.

```ts
await dataSource.transaction(async (manager) => {
  // 1. Idempotency guard (unique violation -> return early)
  await manager.insert(ProcessedEventEntity, {
    eventId: event.eventId,
    consumer: 'recommendations',
    processedAt: new Date(),
  });

  // 2. Accumulate co-purchase pairs
  for (const [a, b] of pairs) {
    await manager.query(`
      INSERT INTO co_purchases (product_a, product_b, count, updated_at)
      VALUES ($1, $2, 1, now())
      ON CONFLICT (product_a, product_b)
      DO UPDATE SET count = co_purchases.count + 1, updated_at = now()
    `, [a, b]);
  }
});
```

If the handler crashes after incrementing but before acknowledging RabbitMQ, the transaction rolls back both the counter and the marker. When RabbitMQ redelivers the message, the transaction retries cleanly. If RabbitMQ redelivers after commit, the `ProcessedEventEntity` insert hits a unique constraint violation and exits as a no-op.

**The architectural rule:**
- Projections of *full entity state* can be made idempotent via **store-level version guards** (ADR-0011).
- Projections of *delta accumulations* require **transactional event markers** (`processed_events`).

---

## 5. Where the model lives: three architectural alternatives

Where should the co-purchase table, consumer, and read endpoint live?

| Option | Store | Port | Pros | Cons |
|---|---|---|---|---|
| **Option A: New `recommendations-service`** | New Neon DB (`recommendations_db`) | 3012 | Clean boundary; isolates recommendation failures from catalog; follows M10/M13 precedent. | Requires a 10th Neon DB (free-tier exhaustion); adds 12th container to 7.6GB Docker VM; cold boot latency. |
| **Option B: Module in `catalog-service`** | Existing `catalog_db` | 3002 | **0 new Neon databases**; **0 new containers**; product page already queries catalog; outbox/TypeORM already present. | Catalog becomes a subscriber to order events (breaks publish-only purity from M12 step 1). |
| **Option C: Second index in `search-service`** | OpenSearch | 3009 | Search already handles projections; no new Postgres DB. | **Cannot do transactional deduplication**; OpenSearch lacks transactions; unbounded tracking of order IDs inside documents. |

### Why Option C fails

Option C is disqualified by §4. OpenSearch has no multi-document transactions. To make an increment idempotent in OpenSearch without Postgres, each document would have to store an array of `processedOrderIds: ["ord-1", "ord-2", ...]` and run a painless script to check existence before incrementing. For popular products, this array grows unbounded, causing document bloat, high GC overhead, and eventual mapping failure.

### Comparing Option A vs Option B

1. **Infrastructure cost and limits:**
   - `HANDOFF.md` §4 and §10 note that Neon free tier accounts historically permitted 5 projects. The repo currently runs 9 Postgres databases across services (`users`, `catalog`, `inventory`, `orders`, `payments`, `cart`, `pricing`, `shipping`, `reviews`). Adding `recommendations_db` creates a 10th Neon database.
   - Docker Desktop is already running near its 7.6 GB RAM ceiling with 12 containers plus OpenSearch's JVM (`HANDOFF.md` §9). Adding an 11th NestJS microservice increases heap pressure and compose start times.

2. **Domain boundaries:**
   - In domain-driven design, recommendations is an *analytical / discovery read model*, closely aligned with browsing and catalog presentation.
   - The storefront product page (`/products/[slug]`) already fetches catalog for product details (`GET /catalog/products/:slug`). Fetching co-purchases from catalog (`GET /catalog/products/:id/recommendations`) or a unified endpoint avoids an extra gateway routing layer and inter-service hop.

3. **Event symmetry:**
   - Catalog was made publish-only in M12 step 1. Giving catalog an active queue (`catalog-service.order-confirmed.recommendations`) makes catalog a consumer. However, catalog already has `RabbitMQModule` and TypeORM wired.

### Decision: **Option A — a separate `recommendations-service` on port 3012**

The draft of this plan recommended Option B. That was reversed on review, for
three reasons.

**1. Option B reverses a decision that is written down.** M12 step 1 made
catalog deliberately publish-only: `RabbitMQModule.forRoot` with no `queue`,
and a class comment explaining that a queue there would receive events nobody
handles. Option B gives catalog a queue and an order-event consumer. Undoing
a recorded decision needs a stronger reason than convenience, and if it were
done it would need its own ADR arguing against M12's.

**2. It inverts the dependency direction.** catalog is the most upstream
service in the system: everything reads from it and it depends on nothing but
RabbitMQ. Its compose block lists no service dependency at all. Today the flow
is orders → pricing → catalog. Option B adds orders → catalog, making the
cleanest service in the project downstream of the most entangled one. That is
a worse shape than one extra container.

**3. The infrastructure argument rests on a stale fact.** The "5 Neon
projects" figure in `HANDOFF.md` §4 was written at M0. The account currently
holds nine and a tenth (`reviews_db`) was provisioned during M13 without
hitting a limit. On memory: an eleventh Nest container costs roughly 100 MB
against OpenSearch's measured 970 MB. Neither is a reason to compromise the
boundary — **but confirm the Neon limit in the console before step 2**, and if
it genuinely blocks, see the fallback below.

**Fallback, if a tenth Neon project is impossible.** Not catalog. Either
**defer M14** — `PROJECT_PLAN.md` lists it fourth on the cut list, "minor;
search and reviews carry R3" — or put the table in **`orders_db`**, where the
data originates and where consuming `order.confirmed` is not a reversal of
anything. Both are more honest than making catalog a consumer.

**What Option A costs, stated plainly:** a tenth Neon project, an eleventh
container, ~90 s more cold-start, and one more `.env` to recreate on a new
machine. The scaffold is a copy of reviews-service's (M13 step 2), which is
itself a copy of shipping's.

---

## 6. The pair table: topology, ordering, and queries

### Pair generation from an order

When an order is confirmed, `items` contains an array of lines: `[{ productId, sku, qty }]`.

1. **Extract distinct product IDs:**
   If a customer buys 2 of item A and 1 of item B on multiple lines:
   $$\text{products} = \text{Array.from}(\text{new Set}(\text{items.map}(i \implies i.productId)))$$

2. **Handle $N < 2$:**
   If $\text{products.length} < 2$, the order contains no co-purchases. The event is recorded in `processed_events` and the handler returns immediately.

3. **Generate pairs for $N \ge 2$:**
   An order with $N$ distinct items produces $\frac{N(N - 1)}{2}$ unique undirected pairs.
   For example, an order with 3 products $\{A, B, C\}$ produces:
   $$\{A, B\}, \{A, C\}, \{B, C\}$$

### Storage representation: Directed vs Canonical Undirected

#### Alternative 1: Canonical Undirected (`product_a < product_b`)
Store each pair once in lexicographical order:
- Table: `co_purchases (product_a, product_b, count, updated_at)`
- Constraint: `CHECK (product_a < product_b)`, `PRIMARY KEY (product_a, product_b)`
- Inserts: 3 rows for 3 products.
- Read query for product $X$:
  ```sql
  SELECT
    CASE WHEN product_a = $1 THEN product_b ELSE product_a END AS recommended_product_id,
    count
  FROM co_purchases
  WHERE product_a = $1 OR product_b = $1
  ORDER BY count DESC
  LIMIT $2;
  ```
- *Trade-off:* Half the storage rows, but the read query requires an `OR` index scan across two columns (`product_a` and `product_b`) and a `CASE` expression.

#### Alternative 2: Symmetric Directed (`source_product_id, target_product_id`)
Store both directions for every pair:
- Table: `product_recommendations (product_id, recommended_product_id, count, updated_at)`
- Constraint: `CHECK (product_id <> recommended_product_id)`, `PRIMARY KEY (product_id, recommended_product_id)`
- Inserts: 6 rows for 3 products ($(A,B), (B,A), (A,C), (C,A), (B,C), (C,B)$).
- Read query for product $X$:
  ```sql
  SELECT recommended_product_id, count
  FROM product_recommendations
  WHERE product_id = $1
  ORDER BY count DESC
  LIMIT $2;
  ```
- *Trade-off:* Twice the write rows, but the read path is a single, lightning-fast B-tree index scan on `(product_id, count DESC)`.

### Recommendation: **Alternative 2 (Symmetric Directed)**

E-commerce is read-heavy. The product page reads recommendations on every visit, while writes occur only when an order confirms (a terminal saga event). A table storing symmetric rows allows the read query to use a direct composite index `(product_id, count DESC)`, eliminating `OR` scans and projection unions.

```sql
CREATE TABLE product_recommendations (
  product_id UUID NOT NULL,
  recommended_product_id UUID NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_product_recommendations PRIMARY KEY (product_id, recommended_product_id),
  CONSTRAINT chk_different_products CHECK (product_id <> recommended_product_id),
  CONSTRAINT chk_count_positive CHECK (count > 0)
);

CREATE INDEX idx_recommendations_lookup
ON product_recommendations (product_id, count DESC);
```

### The Upsert Query

```sql
INSERT INTO product_recommendations (product_id, recommended_product_id, count, updated_at)
VALUES ($1, $2, 1, now())
ON CONFLICT (product_id, recommended_product_id)
DO UPDATE SET
  count = product_recommendations.count + 1,
  updated_at = now();
```

---

## 7. Replay: the hard problem

In M12 and M13, ADR-0012 established the rule:
> **Every write side owns its replay.**
> A rebuilt read model needs one replay command per write side that feeds it.

In M12, `POST /catalog/admin/republish` walked the `products` table and emitted current versions.
In M13, `POST /reviews/admin/republish` walked `product_ratings` and emitted current versions.

### Why recommendations replay is fundamentally harder

The write side for recommendations is **`orders-service`**.

Orders-service's outbox is a **delivery queue, not a retained event log**. Once an event is published to RabbitMQ, `published_at` is stamped; older outbox entries may eventually be pruned.

If `product_recommendations` is dropped or corrupted, how can it be rebuilt?

#### Alternative 1: Orders-service replays `order.confirmed`
`POST /orders/admin/republish-confirmed` walks all historical orders with status `CONFIRMED` and emits `order.confirmed` events.
- **The danger:** Three other services consume `order.confirmed`!
  - `shipping-service` consumes it to create shipments.
  - `reviews-service` consumes it to populate purchases.
  - `notifications-service` (M15) will consume it to send customer emails!
- Re-emitting `order.confirmed` on the general bus risks duplicate shipments or duplicate emails if any consumer has a gap in its deduplication logic.

#### Alternative 2: A dedicated replay event (`order.co_purchase_replayed`)
Orders-service emits a specific event only bound to recommendations:
`order.co_purchase_replayed { orderId, items: [{ productId }] }`.
- **The cost:** Adds a synthetic event type used only for admin replay.

#### Alternative 3: An internal batch rebuild endpoint / script
`POST /catalog/admin/rebuild-recommendations` (or an admin command) queries orders-service's internal API (`GET /orders/internal/confirmed-items-batch`) via a streaming cursor or paginated batch, clearing `product_recommendations` and recomputing pair counts directly in a background migration job.
- **The cost:** Breaks the strict "no cross-service HTTP bulk transfer" rule, but mirrors how real data warehouse / analytics backfills work.

#### Alternative 4: Accept that recommendations is an ephemeral model
Acknowledge the honest reality of operational microservices:
*A co-purchase graph is a warm-start accumulator, not critical ledger state.* If the recommendations database is lost, counts start fresh from subsequent orders, or are reseeded from a static snapshot.

### Decision: **Alternative 2 — a dedicated replay event**

`POST /orders/admin/replay-co-purchases` walks confirmed orders and emits
`order.co_purchase_replay { orderId, items: [{ productId }] }`, bound **only**
to recommendations-service's queue.

Alternative 1 — re-emitting `order.confirmed` on the shared bus — is rejected,
and not on grounds of taste. Three services consume that event and M15 adds a
fourth whose job is **sending email**. A backfill that mails every customer
about an order they placed months ago is not a duplicate row to be cleaned up;
it is a visible failure that cannot be withdrawn. "The other consumers have
idempotency keys" is an argument that the blast radius is *probably* contained,
and probably is not good enough when the cost of being wrong is that high.
Relying on every present and future consumer of a broadcast event to be
perfectly idempotent is exactly the coupling events are supposed to remove.

The cost of Alternative 2 is honest and small: one event type that exists only
for replay, bound to one queue. It is the same shape as the existing
`<target>.<verb>_requested` naming — a message aimed at one consumer rather
than a fact announced to everyone — and `HANDOFF.md` §3 already draws that
distinction.

**Idempotency still applies to the replay.** The replayed event carries the
original `orderId`, and the consumer's `processed_events` marker is keyed on
the event id — so a replay must **clear the markers for replayed orders, or
truncate and rebuild**, not simply re-send. The step-4 proof is therefore:
truncate `product_recommendations` **and** the matching `processed_events`
rows → replay → counts identical. State that explicitly in the step, because
a replay that silently no-ops is the easiest way to think this works when it
does not.

Alternative 4 (accept the model as ephemeral) is worth recording as the
pragmatic real-world answer, and is what a production system might well
choose. It is rejected here only because rebuilding a read model is the thing
R3 exists to teach, and a projection that cannot be rebuilt would be the one
exception in a set of three.

---

## 8. Shape of the changes

Assuming **Option B** (module in `catalog-service`):

```
apps/catalog-service/
  src/database/migrations/
    …-CreateProductRecommendations.ts        product_recommendations table + indices
    …-CreateProcessedEvents.ts              processed_events table (if missing from catalog)
  src/modules/recommendations/
    product-recommendation.entity.ts         (product_id, recommended_product_id, count, updated_at)
    recommendations.service.ts               recordOrderPairs(items), getRecommendations(productId, limit)
    recommendations.controller.ts            GET /catalog/products/:productId/recommendations
  src/events/
    order-events.listener.ts                 consumes order.confirmed -> handleOnce -> recordOrderPairs

storefront/
  lib/types.ts                               ProductRecommendation type
  components/ProductCard.tsx                 (or reusable card for recommendation grid)
  app/products/[slug]/page.tsx               "Customers also bought" section below product details
  e2e/recommendations.spec.ts                Playwright test: buy Mug + Tee -> Mug page shows Tee

apps/api-gateway/
  src/routes/                                Ensure GET /catalog/products/:id/recommendations is public
```

### The API

```
GET /api/v1/catalog/products/:productId/recommendations?limit=4
```
**Public.** Returns:
```json
[
  {
    "productId": "8386bb29-d8fd-4455-90cf-9498e35cad3f",
    "name": "White Mug",
    "slug": "white-mug",
    "priceMinor": 1250,
    "currency": "USD",
    "ratingAvgE2": 450,
    "ratingCount": 2,
    "coPurchaseCount": 5
  }
]
```

Notice that returning product metadata (`name`, `slug`, `priceMinor`, `ratingAvgE2`) directly from catalog avoids the N+1 problem on the storefront.

---

## 9. Storefront

### Placement on Product Page

`app/products/[slug]/page.tsx`:
- Rendered below the primary purchase card and above or below the customer reviews section.
- Heading: **"Customers also bought"** (`data-testid="recommendations-section"`).
- Displays a horizontal card grid of recommended products.
- Each card shows: product name (link to slug), base price, and `<Stars ratingAvgE2={...} ratingCount={...} />`.
- **Renders nothing** when the product has no co-purchases (`data-testid="recommendations-section"` not rendered, keeping new/unpaired product pages clean).

### Eventual consistency

A co-purchase pair is computed when `order.confirmed` is published by the saga.
Latency is expected to be under 2 seconds from Stripe confirmation to the recommendation appearing in the database.

---

## 10. Verification

### Unit tests (no database, no RabbitMQ)

- **Pair generation logic:**
  - Order with 0 items $\implies 0$ pairs.
  - Order with 1 item $\implies 0$ pairs.
  - Order with duplicate item lines $\implies$ deduplicated, correct count.
  - Order with 2 items $\{A, B\} \implies 2$ symmetric pairs: $(A, B)$ and $(B, A)$.
  - Order with 4 items $\implies 12$ symmetric pairs ($4 \times 3$).
  - Self-pairs $(A, A)$ never generated.

### Integration / Database tests

- **Atomic upsert:**
  - First occurrence inserts with `count = 1`.
  - Second occurrence increments to `count = 2`.
  - Concurrent upserts on the same pair do not deadlock or drop counts.
- **Idempotency guard:**
  - Delivering the same `eventId` twice results in exactly 1 increment; the second delivery is an early return from `handleOnce`.

### End-to-end / Live stack verification

1. **Place multi-item order:**
   - Checkout with `White Mug` and `Black Tee (M)`.
   - Confirm payment via Stripe sandbox.
   - Wait for saga to reach `CONFIRMED`.
2. **Verify database:**
   - Check `product_recommendations` table has rows for `(Mug, Tee)` and `(Tee, Mug)` with `count = 1`.
3. **Verify API:**
   - `GET /catalog/products/:mugId/recommendations` returns `Black Tee`.
   - `GET /catalog/products/:teeId/recommendations` returns `White Mug`.
4. **Verify storefront:**
   - Visit `/products/white-mug`: "Customers also bought" is visible, showing `Black Tee (M)`.
   - Visit `/products/grey-hoodie-medium` (never co-purchased): "Customers also bought" section is absent.
5. **Redelivery proof:**
   - Re-publish the exact same `order.confirmed` message to the queue.
   - Assert `count` remains 1; no double increment occurs.

---

## 11. Definition of Done

- [ ] `order.confirmed` consumed by recommendations listener; `order.paid` referenced nowhere.
- [ ] Recommendations table with symmetric pairs `(product_id, recommended_product_id, count)`.
- [ ] Single-item orders acknowledge cleanly without creating pairs.
- [ ] Duplicate item lines in an order are deduplicated prior to pair generation.
- [ ] **Increment is strictly idempotent**: redelivered event ID leaves pair counters unchanged (proved with live redelivery test).
- [ ] `GET /recommendations/products/:productId` public through the gateway, returning top co-purchased products ordered by count DESC.
- [ ] Storefront: "Customers also bought" section on product page; renders cards with stars and price; renders nothing when unranked/empty.
- [ ] `POST /orders/admin/replay-co-purchases` emitting `order.co_purchase_replay`; **truncate + clear markers → replay → counts identical**, and no other consumer sees the replay.
- [ ] E2E Playwright test: purchase multi-item basket $\implies$ recommendation visible on product page.
- [ ] `npm run lint` in storefront reports exactly 1 problem (pre-existing `poll` error); TypeScript clean across repo.
- [ ] **ADR-0013** written: accumulators vs versioned projections; why delta projections require transactional event markers; pair topology choice; infrastructure location.
- [ ] Corrections merged into `IMPLEMENTATION_PLAN.md` §4; `HANDOFF.md` updated.

---

## 12. Before starting

1. **Settled (§5):** Option A — a separate `recommendations-service` on port
   3012 with its own Neon database.
2. **Provision `recommendations_db` in Neon** and put the string in
   `apps/recommendations-service/.env` **directly** — never into a chat
   transcript; two credentials have been rotated for that already
   (`HANDOFF.md` §9). Confirm the project limit first; if it blocks, take
   §5's fallback rather than Option B.
3. **Settled (§7):** a dedicated `order.co_purchase_replay` event bound only
   to recommendations.
4. **Ensure Docker stack health:** Run `docker compose ps` to ensure PostgreSQL, RabbitMQ, and OpenSearch are healthy before testing.

---

## 13. Suggested order of work

One commit per step. Steps 1–4 are backend and CQRS correctness; steps 5–6 are storefront and documentation.

1. **Entities, migrations and pair arithmetic**
   - Migration for `product_recommendations` and `processed_events`.
   - Pure unit tests for the pair generator (0 items, 1 item, duplicates, $N$ items).
2. **The idempotent consumer**
   - Bind the `order.confirmed` queue in recommendations-service.
   - Implement `handleOnce` with atomic `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1`.
   - Proof: redelivering the same event leaves counts unchanged.
3. **The public read API**
   - `GET /recommendations/products/:productId?limit=4`.
   - Join/fetch product details, prices, and ratings.
   - Gateway routing and swagger documentation.
4. **Replay**
   - `POST /orders/admin/replay-co-purchases` emitting `order.co_purchase_replay`,
     bound only to recommendations.
   - Proof: snapshot the counts, truncate `product_recommendations` **and the
     `processed_events` rows for those orders**, replay, counts identical.
   - Proof: shipping and reviews see nothing — no new shipment, no new
     purchase row.
5. **Storefront integration**
   - `types.ts` updates.
   - "Customers also bought" section on `/products/[slug]`.
   - Verification of empty state vs populated state.
6. **Playwright E2E and ADR-0013**
   - Multi-item checkout test in `e2e/recommendations.spec.ts`.
   - Write ADR-0013 and update `HANDOFF.md`.

---

## 14. Questions, settled on review (2026-10-06)

1. **Service boundaries — settled: Option A.** A separate
   `recommendations-service` on port 3012 with its own Neon database. Option B
   would have reversed M12's publish-only decision for catalog and inverted the
   dependency direction, for an infrastructure saving that rests on a stale
   figure. §5 has the full argument and the fallback if Neon blocks it.

2. **Replay safety — settled: a dedicated event.**
   `order.co_purchase_replay`, bound only to recommendations. Re-emitting
   `order.confirmed` would reach shipping, reviews and M15's email sender; an
   email cannot be un-sent, and "the other consumers are probably idempotent"
   is not a good enough guarantee for that. §7 has the argument.

3. **Minimum co-purchase threshold — settled: no threshold; show at count ≥ 1.**
   A threshold is a product decision dressed as an engineering one, and with
   twelve seeded products and a handful of orders a `count >= 2` rule would
   render the feature permanently empty — including in Playwright, which would
   then be testing nothing. The read endpoint takes `limit` and orders by count
   descending; if a real catalogue ever made one-off pairs noisy, a threshold
   is one `WHERE` clause and belongs in the commit that has the evidence for
   it. Record it as a known simplification rather than a decision avoided.

### Still genuinely open

- **Whether the read endpoint should enrich hits.** A recommendation is a
  product id and a count; the storefront needs a name, price and image to draw
  a card. Either recommendations-service calls catalog (another synchronous
  read, the M8/M10 pattern), or it returns ids and the storefront fetches them,
  or it projects a minimal product snapshot the way search does. Decide this at
  step 3 with the code in front of you; the plan does not need to guess.
