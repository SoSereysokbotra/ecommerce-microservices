# DevOps & Observability Implementation Log

> **Repository:** `ecommerce-microservices`  
> **Status:** Phase 1 (CI/CD Pipeline) & Phase 2 (Distributed Tracing & Observability) **Completed**  
> **Date:** October 2026  
> **Target Audience:** Developers, DevOps Engineers, System Architects  

---

## 1. Executive Summary

This document describes all engineering changes implemented in this repository to transition the platform from a local-only microservices prototype into a production-grade, observable, and resilient distributed system.

### What Was the Problem Before?
1. **No Distributed Context:** When an order checkout failed or slowed down, logs were scattered across 15 separate Docker containers (`api-gateway`, `orders-service`, `inventory-service`, `payments-service`, `shipping-service`, etc.). Searching logs required manually guessing timestamps across independent terminals with no shared trace identifier.
2. **RabbitMQ Event Isolation:** When an event was published to RabbitMQ or stored in the database Outbox table, the originating HTTP request trace was lost. Downstream asynchronous consumers (like search projection or shipping) could not correlate events back to the customer's action.
3. **Slow & Inefficient CI:** GitHub Actions was set to rebuild everything on every commit, wasting compute credits and build time on unchanged code.

---

## 2. Phase 1 Implementation: Monorepo CI/CD Pipeline

### File Modified
* [`.github/workflows/ci.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/.github/workflows/ci.yml)

### Key Features Added
1. **Path-Based Change Filtering (`dorny/paths-filter@v3`):**
   * Automatically analyzes git diffs between commits.
   * If you only edit `storefront/`, backend tests are skipped.
   * If you only edit `catalog-service`, other services are not needlessly rebuilt.
   * If shared libraries (`libs/**`) change, all dependent services run validation.
2. **Concurrency Control:**
   * Automatically cancels outdated in-progress workflow runs when new commits are pushed to the same pull request or branch (`concurrency.group`).
3. **Multi-Stage Docker Image Verification Matrix:**
   * Uses `docker/build-push-action@v5` with GitHub Actions BuildKit layer cache (`cache-from: type=gha`, `cache-to: type=gha,mode=max`).
   * Validates multi-stage Docker builds in parallel across key microservices (`api-gateway`, `catalog-service`, `orders-service`, `recommendations-service`).
4. **Security & API Contract Scans Preserved:**
   * Secret scanning via `scripts/scan-secrets.sh`.
   * Strict OpenAPI schema contract verification via `scripts/gen-api-types.sh`.

---

## 3. Phase 2 Implementation: Distributed Tracing & Unified Observability

### Architecture Diagram: End-to-End Trace Flow

```
[ Storefront (Browser) ]
       │
       │ HTTP Request: Headers injected
       │   x-correlation-id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
       │   traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        API Gateway (Port 3000)                         │
│  - CorrelationIdMiddleware: extracts & mounts context in AsyncLocalStorage
│  - LoggingInterceptor: logs request with traceId & latency             │
│  - ProxyService: injects child span & forwards downstream headers      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Inter-service HTTP
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Orders Service (Port 3004)                         │
│  - Receives traceparent & correlationId via CorrelationIdMiddleware    │
│  - HTTP Client calls users-service & pricing-service with traceparent   │
│  - Database Transaction: Appends event + traceparent to Outbox table   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Outbox Relay
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       RabbitMQ (commerce.events)                       │
│  - AMQP Message Properties Headers:                                    │
│      'x-correlation-id': "9b1deb4d-..."                                │
│      'traceparent': "00-4bf92f3577b34da6a3ce929d0e0e4736-..."         │
│  - Payload envelope preserves correlationId & traceparent              │
└───────────────────┬───────────────────────────────┬────────────────────┘
                    │                               │
                    ▼ AMQP Event                    ▼ AMQP Event
┌─────────────────────────────────┐   ┌──────────────────────────────────┐
│   Shipping Service (Port 3008)  │   │   Search Service (Port 3009)     │
│  - Extracts AMQP trace headers  │   │  - Extracts AMQP trace headers   │
│  - Runs consumer in traceContext│   │  - Runs consumer in traceContext │
│  - All logs tagged with traceId │   │  - All logs tagged with traceId  │
└─────────────────────────────────┘   └──────────────────────────────────┘
```

---

### Detailed Code Changes & Files

#### 1. W3C Trace Context Standard & AsyncLocalStorage Engine
* **File:** [`libs/common/src/tracing/trace-context.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/tracing/trace-context.ts)
* **What it does:**
  * Implements official W3C Trace Context specifications (`00-{traceId:32hex}-{spanId:16hex}-{flags:02hex}`).
  * Functions: `parseTraceparent()`, `generateTraceIds()`, `buildTraceparent()`, `createTraceContext()`, `createChildSpanContext()`.
  * Utilizes Node.js native `AsyncLocalStorage` (`storage.run(ctx, () => ...)`). Any code executed inside that asynchronous call stack can retrieve `getTraceContext()` without changing function signatures.
* **Unit Test:** [`apps/orders-service/test/tracing.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/test/tracing.spec.ts) (100% pass).

#### 2. Universal Middleware Upgraded
* **File:** [`libs/common/src/middleware/correlation-id.middleware.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/middleware/correlation-id.middleware.ts)
* **What it does:**
  * Runs on every incoming HTTP request across all 12 microservices.
  * Reads `x-correlation-id` and `traceparent`. If missing, generates a valid W3C trace context.
  * Injects `x-correlation-id` and `traceparent` on both request (`req.headers`) and response (`res.setHeader`).
  * Wraps the entire NestJS request chain in `runWithTraceContext(ctx, () => next())`.

#### 3. Storefront Tracing Injection
* **File:** [`storefront/lib/api.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/storefront/lib/api.ts)
* **What it does:**
  * The frontend client `request()` helper generates a unique W3C `traceparent` and `x-correlation-id` for every browser click, cart action, and search query.
  * The user's browser action is directly linked to backend container logs.

#### 4. API Gateway Proxy Forwarding
* **Files:** [`apps/api-gateway/src/proxy/proxy.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/api-gateway/src/proxy/proxy.service.ts), [`apps/api-gateway/src/main.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/api-gateway/src/main.ts)
* **What it does:**
  * Forwards `traceparent` and `x-correlation-id` to downstream internal services.
  * Adds `LoggingInterceptor` globally to log method, URL, status code, latency, and traceId.
  * Configures CORS headers: `allowedHeaders` and `exposedHeaders` include `traceparent` and `x-correlation-id`.

#### 5. Inter-Service HTTP Clients
All internal synchronous clients now forward `traceparent`:
* [`apps/orders-service/src/modules/orders/users.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/src/modules/orders/users.client.ts) (Orders $\rightarrow$ Users)
* [`apps/pricing-service/src/modules/pricing/shipping.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/pricing-service/src/modules/pricing/shipping.client.ts) (Pricing $\rightarrow$ Shipping)
* [`apps/pricing-service/src/modules/pricing/catalog.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/pricing-service/src/modules/pricing/catalog.client.ts) (Pricing $\rightarrow$ Catalog)
* [`apps/reviews-service/src/modules/reviews/users.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/reviews-service/src/modules/reviews/users.client.ts) (Reviews $\rightarrow$ Users)
* [`apps/recommendations-service/src/modules/recommendations/catalog.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/recommendations-service/src/modules/recommendations/catalog.client.ts) (Recommendations $\rightarrow$ Catalog)
* [`apps/cart-service/src/modules/cart/inventory.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/cart-service/src/modules/cart/inventory.client.ts) (Cart $\rightarrow$ Inventory)

#### 6. RabbitMQ & Outbox Relay Integration
* **Files:** [`libs/rabbitmq/src/rabbitmq.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/rabbitmq/src/rabbitmq.service.ts), [`libs/outbox/src/outbox.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/outbox/src/outbox.service.ts), [`libs/outbox/src/outbox.relay.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/outbox/src/outbox.relay.ts)
* **Publishing (`publish` & `publishOrThrow`):**
  * Reads the active context from `getTraceContext()`.
  * Generates a child span ID so the message has its own span linked to the parent trace.
  * Injects `traceparent` and `x-correlation-id` into AMQP message properties (`headers`) and JSON payload envelope.
* **Consuming (`consume`):**
  * Extracts AMQP headers (`message.properties.headers['traceparent']`) or payload values.
  * Initializes a `TraceContext` and executes consumer handlers inside `runWithTraceContext(consumerCtx, ...)`.
  * Any logs emitted by event consumers (e.g., Shipping, Search, Reviews) automatically display the original `traceId` and `correlationId`.
* **Outbox:**
  * When database transactions append to the Outbox table via `outbox.append()`, the active `traceparent` is stored in the database row payload.
  * The Outbox relay extracts and publishes it to RabbitMQ, maintaining uninterrupted distributed traces through PostgreSQL and RabbitMQ.

#### 7. Structured JSON & Observability Logging
* **Files:** [`libs/common/src/interceptors/logging.interceptor.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/interceptors/logging.interceptor.ts), [`libs/common/src/utils/logger.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/utils/logger.ts)
* Supports two modes:
  * **Development (`NODE_ENV !== 'production'`):** Human-friendly colored terminal logs with `[trace:...]` and `[corr:...]`.
  * **Production (`NODE_ENV=production` or `LOG_FORMAT=json`):** Single-line JSON containing:
    ```json
    {
      "timestamp": "2026-10-07T16:20:00.000Z",
      "level": "info",
      "service": "orders-service",
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "00f067aa0ba902b7",
      "correlationId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "method": "POST",
      "path": "/api/v1/orders/checkout",
      "statusCode": 201,
      "durationMs": 42
    }
    ```

---

## 4. LGTM Observability Stack (Loki, Tempo, Prometheus, Grafana)

A dedicated, lightweight Docker Compose configuration was created to run the entire Grafana observability suite alongside your application containers.

### File
* [`docker-compose.observability.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/docker-compose.observability.yml)

### Services & Ports

| Service | Port | Purpose | Default Credentials / URL |
| :--- | :--- | :--- | :--- |
| **Grafana** | `3050` | Central web UI for traces, logs, and dashboards | `http://localhost:3050`<br>User: `admin`<br>Password: `admin` |
| **Tempo** | `3200` | Distributed trace backend (OTLP gRPC `4317`, HTTP `4318`) | `http://localhost:3200` |
| **Loki** | `3101` | High-efficiency log aggregator | `http://localhost:3101` |
| **Prometheus**| `9090` | System and service metrics scraper | `http://localhost:9090` |

### Pre-Provisioned Configurations in [`observability/`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability)
1. **Loki (`observability/loki/loki-config.yaml`):** TSDB schema indexing logs by container, service, and trace ID.
2. **Tempo (`observability/tempo/tempo-config.yaml`):** Ingests trace spans and stores local blocks.
3. **Prometheus (`observability/prometheus/prometheus.yaml`):** Scrapes metric targets.
4. **Grafana Data Sources (`observability/grafana/provisioning/datasources/datasources.yaml`):**
   * Configures Loki and Tempo.
   * **Trace-to-Logs linking:** Clicking on a trace in Tempo displays the exact container logs in Loki.
   * **Logs-to-Trace linking:** Clicking any `traceId` in Loki logs opens the full waterfall trace graph in Tempo.
5. **Pre-built Dashboard (`observability/grafana/dashboards/commerce-dashboard.json`):**
   * Live search filter for container logs by `traceId` or `correlationId`.

---

## 5. Quick Commands & Verification

### Managing the Observability Stack

```bash
# 1. Start Grafana, Tempo, Loki, Prometheus in the background
## 5. Phase 3 Implementation: RabbitMQ Resilience & Dead Letter Queues (DLQ)

### What Was the Problem Before?
In asynchronous messaging architectures, failures fall into two categories:
1. **Transient Network or DB Hiccups:** A database query timed out or a connection pool was briefly saturated. Dropping the event immediately (`nack(message, false, false)`) lost customer shipments or order updates permanently.
2. **Poison Messages:** A corrupt payload or unhandled edge-case triggered an unrecoverable exception. If requeued (`requeue: true`), RabbitMQ entered an infinite processing loop burning 100% CPU and blocking all subsequent events in the queue.

### Architecture: Dead Letter Exchange (DLX) & Exponential Backoff

```
                                  [ RabbitMQ Exchange ]
                                    (commerce.events)
                                            │
                                            ▼
                           ┌──────────────────────────────────┐
                           │   Main Service Queue             │
                           │   (e.g., shipping-service)       │
                           └────────────────┬─────────────────┘
                                            │ Consume
                                            ▼
                            ┌───────────────────────────────┐
                            │    Message Processing         │
                            └───────┬───────────────┬───────┘
                                    │               │
                            Success │               │ Throws Exception
                                    ▼               ▼
                                 [ ACK ]    Attempt < MaxRetries (3)?
                                                    │
                                           ┌────────┴────────┐
                                      YES  │                 │ NO (Poison Pill)
                                           ▼                 ▼
                               ┌───────────────────────┐ ┌───────────────────────────┐
                               │ Exponential Backoff   │ │ Dead Letter Exchange      │
                               │ Retry (1s, 2s, 4s)    │ │ (commerce.dlx)            │
                               │ with 'x-retry-count'  │ └─────────────┬─────────────┘
                               └───────────────────────┘               │
                                                                       ▼
                                                         ┌───────────────────────────┐
                                                         │ Dead Letter Queue (DLQ)   │
                                                         │ (shipping-service.dlq)    │
                                                         │ Headers:                  │
                                                         │  x-quarantine-reason      │
                                                         │  x-quarantine-error       │
                                                         │  x-quarantine-at          │
                                                         │  x-original-routing-key   │
                                                         │  x-correlation-id         │
                                                         └─────────────┬─────────────┘
                                                                       │
                                                         ┌─────────────┴─────────────┐
                                                         │ Admin Redrive / Replay    │
                                                         │ npm run dlq:replay -- ... │
                                                         └───────────────────────────┘
```

### Detailed Features Implemented

#### 1. Dead Letter Exchange (DLX) & Queue Binding
* **File:** [`libs/rabbitmq/src/rabbitmq.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/rabbitmq/src/rabbitmq.service.ts)
* Every service queue automatically provisions a paired Dead Letter Queue (`<queue>.dlq`) bound to `commerce.dlx`.
* Main queues are configured with `x-dead-letter-exchange` pointing to `commerce.dlx`.

#### 2. Exponential Backoff Retry (1s, 2s, 4s)
* When a message throws an exception in a consumer handler, RabbitMQService checks `'x-retry-count'`.
* If retries are under `maxRetries` (default: 3), the message is scheduled for delayed redelivery with progressive exponential backoff:
  $$\text{backoffMs} = \text{retryBackoffMs} \times 2^{\text{attempts}}$$
* The original message is acknowledged so it does not block the queue.

#### 3. Poison Message Quarantine with Diagnostic Headers
* If a message fails after 3 attempts, it is quarantined to `${queue}.dlq` via `commerce.dlx`.
* Full diagnostic metadata is attached directly to the message headers:
  * `x-quarantine-reason`: `'MaxRetriesExceeded'`
  * `x-quarantine-error`: Error message / exception reason
  * `x-quarantine-at`: ISO-8601 timestamp
  * `x-original-queue`: Originating queue name
  * `x-original-routing-key`: Event routing key (`order.confirmed`, etc.)
  * `x-correlation-id` and `traceparent`: Complete distributed trace context

#### 4. DLQ Replay & Administrative CLI
* **File:** [`scripts/rabbitmq-dlq.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/scripts/rabbitmq-dlq.ts)
* Once an engineer fixes a downstream database or deploys a code fix, quarantined messages can be redriven into the main exchange with clean headers:
  ```bash
  # Check depth of all microservice queues and DLQs
  npm run dlq:stats

  # Redrive up to 50 quarantined messages back into the event exchange
  npm run dlq:replay shipping-service 50

  # Purge quarantined junk messages from a DLQ
  npm run dlq:purge shipping-service
  ```
* **Unit Tests:** [`apps/orders-service/test/rabbitmq-dlq.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/test/rabbitmq-dlq.spec.ts) & [`libs/rabbitmq/src/rabbitmq.service.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/rabbitmq/src/rabbitmq.service.spec.ts) (100% pass).

---

## 6. Quick Commands & Verification

### Managing the Observability Stack
```bash
# 1. Start Grafana, Tempo, Loki, Prometheus in the background
npm run observability:up

# 2. View live logs from the observability containers
npm run observability:logs

# 3. Stop the observability stack
npm run observability:down
```

### Managing Dead Letter Queues (DLQ)
```bash
# Inspect all queue and DLQ depths
npm run dlq:stats

# Replay messages from a DLQ
npm run dlq:replay shipping-service 50

# Purge a DLQ
npm run dlq:purge shipping-service
```

### Running Tests & Code Quality
```bash
# Run tracing unit tests
npm test --prefix apps/orders-service -- tracing.spec.ts

# Run RabbitMQ DLQ unit tests
npm test --prefix apps/orders-service -- rabbitmq-dlq.spec.ts

# Run Saga integration tests
npm test --prefix apps/orders-service -- order-saga.service.spec.ts

# Verify zero lint errors across monorepo
npm run lint
```

---

## 7. Complete Inventory of Files

### New Files Created
* [`docs/DEVOPS_IMPLEMENTATION_LOG.md`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/docs/DEVOPS_IMPLEMENTATION_LOG.md) *(this documentation)*
* [`scripts/rabbitmq-dlq.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/scripts/rabbitmq-dlq.ts) *(DLQ inspector and redrive tool)*
* [`apps/orders-service/test/rabbitmq-dlq.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/test/rabbitmq-dlq.spec.ts) *(RabbitMQ DLQ unit test)*
* [`libs/rabbitmq/src/rabbitmq.service.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/rabbitmq/src/rabbitmq.service.spec.ts) *(RabbitMQ resilience spec)*
* [`libs/common/src/tracing/trace-context.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/tracing/trace-context.ts) *(W3C tracing & AsyncLocalStorage)*
* [`apps/orders-service/test/tracing.spec.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/test/tracing.spec.ts) *(Tracing unit test)*
* [`docker-compose.observability.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/docker-compose.observability.yml) *(LGTM compose stack)*
* [`observability/loki/loki-config.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/loki/loki-config.yaml)
* [`observability/tempo/tempo-config.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/tempo/tempo-config.yaml)
* [`observability/prometheus/prometheus.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/prometheus/prometheus.yaml)
* [`observability/promtail/promtail-config.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/promtail/promtail-config.yaml)
* [`observability/grafana/provisioning/datasources/datasources.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/grafana/provisioning/datasources/datasources.yaml)
* [`observability/grafana/provisioning/dashboards/dashboards.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/grafana/provisioning/dashboards/dashboards.yaml)
* [`observability/grafana/dashboards/commerce-dashboard.json`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/observability/grafana/dashboards/commerce-dashboard.json)

### Files Modified & Enhanced
* [`package.json`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/package.json) *(Added observability & dlq management scripts)*
* [`libs/rabbitmq/src/rabbitmq.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/rabbitmq/src/rabbitmq.service.ts) *(DLX, backoff retry, poison quarantine, DLQ replay)*
* [`docs/DEVOPS_PRODUCTION_ROADMAP.md`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/docs/DEVOPS_PRODUCTION_ROADMAP.md) *(Status table updated)*
* [`.github/workflows/ci.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/.github/workflows/ci.yml) *(Path filtering & Docker BuildKit matrix)*
* [`storefront/lib/api.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/storefront/lib/api.ts) *(Frontend browser trace injection)*
* [`apps/api-gateway/src/main.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/api-gateway/src/main.ts) *(LoggingInterceptor & CORS)*
* [`apps/api-gateway/src/proxy/proxy.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/api-gateway/src/proxy/proxy.service.ts) *(Downstream trace propagation)*
* [`libs/common/src/index.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/index.ts) *(Exports tracing context)*
* [`libs/common/src/middleware/correlation-id.middleware.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/middleware/correlation-id.middleware.ts) *(W3C parsing & AsyncLocalStorage wrap)*
* [`libs/common/src/interceptors/logging.interceptor.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/interceptors/logging.interceptor.ts) *(Structured trace logging)*
* [`libs/common/src/utils/logger.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/common/src/utils/logger.ts) *(StructuredLogger with auto-trace enrichment)*
* [`libs/outbox/src/outbox.service.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/outbox/src/outbox.service.ts) *(Stores trace in outbox)*
* [`libs/outbox/src/outbox.relay.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/libs/outbox/src/outbox.relay.ts) *(Relays trace to RabbitMQ)*
* [`apps/*/src/main.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/users-service/src/main.ts) *(All 11 microservices updated to accept `traceparent`)*
* Cross-service HTTP clients: [`orders/users.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/orders-service/src/modules/orders/users.client.ts), [`pricing/shipping.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/pricing-service/src/modules/pricing/shipping.client.ts), [`pricing/catalog.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/pricing-service/src/modules/pricing/catalog.client.ts), [`reviews/users.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/reviews-service/src/modules/reviews/users.client.ts), [`recommendations/catalog.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/recommendations-service/src/modules/recommendations/catalog.client.ts), [`cart/inventory.client.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/cart-service/src/modules/cart/inventory.client.ts).

