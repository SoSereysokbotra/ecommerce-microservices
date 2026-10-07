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

---

## 6. Phase 4: GitOps & Container Orchestration (Kubernetes, Helm, KEDA, ArgoCD, Terraform)

### Architecture & Overview
Phase 4 provides complete, enterprise-grade cloud-native deployment primitives across 13 services (12 backend NestJS microservices + 1 Next.js storefront).

```
                            ┌────────────────────────────────────────┐
                            │ Git Repository (GitHub: origin/main)   │
                            └───────────────────┬────────────────────┘
                                                │
                                    GitOps Sync │ (Polling / Webhook)
                                                ▼
                            ┌────────────────────────────────────────┐
                            │ ArgoCD GitOps Controller               │
                            │  (apps/deploy/argocd)                  │
                            └─────────┬────────────────────┬─────────┘
                                      │                    │
                        Sync Staging  │                    │ Sync Production
                                      ▼                    ▼
          ┌───────────────────────────────────┐    ┌───────────────────────────────────┐
          │ Namespace: commerce-staging       │    │ Namespace: commerce-production    │
          │ Kustomize Overlay: staging/       │    │ Kustomize Overlay: production/    │
          │  - 1 replica / lower cost         │    │  - 3 replicas HA critical         │
          │  - staging.commerce.example.com   │    │  - shop.example.com               │
          │  - DEBUG logging                  │    │  - WARN logging, strict limits    │
          └─────────────────┬─────────────────┘    └─────────────────┬─────────────────┘
                            │                                        │
                            └────────────────────┬───────────────────┘
                                                 │
                                                 ▼
          ┌────────────────────────────────────────────────────────────────────────────┐
          │ Kubernetes Cluster Infrastructure (Provisioned via deploy/terraform/)       │
          │                                                                            │
          │   Ingress (NGINX + cert-manager)                                           │
          │     ├── /api  ──► api-gateway (ClusterIP: 3000)                             │
          │     └── /     ──► storefront (ClusterIP: 3100)                             │
          │                                                                            │
          │   HorizontalPodAutoscaler (HPA)                                            │
          │     └── api-gateway, cart-service, orders-service, storefront (CPU > 70%)  │
          │                                                                            │
          │   Event-Driven Autoscaling (KEDA)                                          │
          │     └── shipping-service, inventory-service (RabbitMQ backlog > 30 msgs)   │
          └────────────────────────────────────────────────────────────────────────────┘
```

### Components Implemented

#### 1. Kustomize Base & Environment Overlays (`deploy/k8s/`)
* **Base Layer (`deploy/k8s/base/`):**
  * `namespace.yaml`: Defines `commerce` namespace.
  * `configmap.yaml`: Centralized configuration (RabbitMQ host, Redis host, OpenSearch, OTel endpoints, internal service URLs).
  * `secrets.yaml`: Template for JWT secrets, database connection URLs, and Stripe API keys.
  * `services/*.yaml`: 13 isolated manifests for each microservice with RollingUpdate, non-root security contexts, CPU/Memory requests & limits, and Liveness/Readiness probes.
  * `ingress.yaml`: NGINX Ingress routing `/api` to `api-gateway` and `/` to `storefront` with SSL redirection.
  * `hpa.yaml`: HorizontalPodAutoscalers for high-traffic HTTP entry points (`api-gateway`, `cart-service`, `orders-service`, `storefront`).
  * `keda-scaledobjects.yaml`: KEDA triggers scaling worker pods from 2 to 6 when RabbitMQ queues exceed 30 messages.
* **Staging Overlay (`deploy/k8s/overlays/staging/`):**
  * Targets namespace `commerce-staging`, prefixes resources with `staging-`, reduces replicas to 1, sets `LOG_LEVEL=debug`, sets host to `staging.commerce.example.com`.
* **Production Overlay (`deploy/k8s/overlays/production/`):**
  * Targets namespace `commerce-production`, prefixes resources with `prod-`, scales mission-critical deployments to 3 replicas, sets `LOG_LEVEL=warn`, sets host to `shop.example.com`.

#### 2. Enterprise Helm Chart (`deploy/helm/ecommerce-platform/`)
* **File:** [`deploy/helm/ecommerce-platform/Chart.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/helm/ecommerce-platform/Chart.yaml) & [`values.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/helm/ecommerce-platform/values.yaml)
* Reusable, parameterized deployment package for all 13 microservices.
* DRY templates using Go template loops (`templates/deployment.yaml`, `templates/service.yaml`, `templates/hpa.yaml`, `templates/keda.yaml`).
* Validated with `helm lint` (0 errors) and tested with `helm template`.

#### 3. ArgoCD GitOps Automation (`deploy/argocd/`)
* **File:** [`deploy/argocd/project.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/argocd/project.yaml)
* `commerce-platform-staging`: Watches `deploy/k8s/overlays/staging` with automated pruning and self-healing.
* `commerce-platform-production`: Watches `deploy/k8s/overlays/production` with exponential backoff retries and strict sync controls.

#### 4. Terraform Cloud Infrastructure (`deploy/terraform/`)
* **Files:** [`main.tf`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/terraform/main.tf), [`variables.tf`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/terraform/variables.tf), [`outputs.tf`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/terraform/outputs.tf)
* Provisions:
  * Multi-AZ VPC with Public & Private Subnets and NAT Gateway.
  * AWS EKS Cluster (Kubernetes 1.30) with managed worker node groups (t3.xlarge).
  * ElastiCache Redis cluster (Redis 7) with encryption and auto-failover.
  * Security groups and IAM roles for Pod execution (IRSA).

---

## 7. Phase 5: Zero-Trust Security & Secrets Management

### Architecture & Overview
Phase 5 implements zero-trust isolation and automated secrets management across all microservices:
1. **External Secrets Operator (ESO):** Replaces plaintext `.env` and committed secrets by fetching credentials dynamically from AWS Secrets Manager or HashiCorp Vault.
2. **Kubernetes Network Policies (`NetworkPolicy`):** Enforces default-deny ingress and egress, isolates namespace traffic, and explicitly locks down `payments-service` to only reach the external Stripe API (port 443) and internal database/messaging.
3. **Automated Vulnerability & CVE Scanning:** GitHub Actions CI job with Aqua Security Trivy scanning container configurations, manifests, and dependencies for High/Critical CVEs.
4. **Developer Security Audit Suite:** `npm run security:audit` (`scripts/security-audit.sh`) auditing committed secrets, non-root Dockerfiles, and NetworkPolicies.

```
                                ┌──────────────────────────────────────┐
                                │ AWS Secrets Manager / Vault          │
                                └──────────────────┬───────────────────┘
                                                   │
                                      IRSA / Token │ ESO Sync (Hourly)
                                                   ▼
                                ┌──────────────────────────────────────┐
                                │ ExternalSecret Operator              │
                                │ (deploy/k8s/base/security/ext-sec)   │
                                └──────────────────┬───────────────────┘
                                                   │ Creates in-memory
                                                   ▼
                                ┌──────────────────────────────────────┐
                                │ Kubernetes Secret (commerce-secrets) │
                                └──────────────────┬───────────────────┘
                                                   │
                         ┌─────────────────────────┴─────────────────────────┐
                         ▼                                                   ▼
            ┌───────────────────────────┐                       ┌───────────────────────────┐
            │ Pod: api-gateway          │                       │ Pod: payments-service     │
            │ SecurityContext: Non-Root │                       │ SecurityContext: Non-Root │
            └────────────┬──────────────┘                       └─────────────┬─────────────┘
                         │                                                    │
     NetworkPolicy Ingress allowed only                   NetworkPolicy Egress strictly locked:
     from ingress-controller                              - Internal DB (5432) & RabbitMQ (5672)
     NetworkPolicy Egress allowed only                    - External Stripe API only (Port 443)
     to internal services (3001-3011)                     - All other internet access blocked!
```

### Components Implemented

#### 1. External Secrets Operator Manifests (`deploy/k8s/base/security/`)
* [`secret-store.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/security/secret-store.yaml): Configures `SecretStore` providers for AWS Secrets Manager and HashiCorp Vault using IRSA (`external-secrets-sa`).
* [`external-secrets.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/security/external-secrets.yaml): `ExternalSecret` manifest mapping remote secret keys (`jwt_secret`, `stripe_secret_key`, database connection URLs, RabbitMQ passwords) into `commerce-secrets`.

#### 2. Zero-Trust Kubernetes Network Policies (`deploy/k8s/base/security/network-policies.yaml`)
* `default-deny-all`: Denies all ingress and egress across the `commerce` namespace by default.
* `allow-coredns-egress`: Allows UDP/TCP port 53 to `kube-system` CoreDNS.
* `allow-ingress-to-edge`: Permits external ingress only to `api-gateway` (port 3000) and `storefront` (port 3100).
* `allow-gateway-to-services`: Allows `api-gateway` to communicate downstream with microservices on ports 3001–3011.
* `allow-gateway-egress`: Restricts gateway outbound traffic to downstream microservice ports, Redis, and observability.
* `allow-services-to-infrastructure`: Allows microservices egress only to internal infrastructure (Postgres 5432, Redis 6379, RabbitMQ 5672, OpenSearch 9200, OTel 4318, Loki 3100).
* `allow-inter-service-communication`: Permits authorized East-West HTTP calls (`orders` -> `users:3001`, `pricing` -> `shipping:3007` & `catalog:3002`, `reviews` -> `users:3001`, `recommendations` -> `catalog:3002`, `cart` -> `inventory:3006`).
* `allow-payments-to-stripe-egress`: Allows `payments-service` egress to external HTTPS (port 443) for Stripe webhook and payment intent creation, while blocking internet egress from all other database services.

#### 3. Container Vulnerability & CI Scanning
* **GitHub Actions:** Added `security-audit` job to [`.github/workflows/ci.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/.github/workflows/ci.yml) running Aqua Security Trivy for High and Critical CVEs and configuration misconfigurations.
* **Developer CLI Suite:** Created [`scripts/security-audit.sh`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/scripts/security-audit.sh) executable via `npm run security:audit`.

---

## 8. Quick Commands & Verification

### Security Auditing
```bash
# Run comprehensive zero-trust security audit
npm run security:audit
```

### Kubernetes & Helm Validation
```bash
# 1. Validate Kustomize Base manifests (including NetworkPolicies & ESO)
kubectl kustomize deploy/k8s/base

# 2. Validate Kustomize Staging & Production Overlays
kubectl kustomize deploy/k8s/overlays/staging
kubectl kustomize deploy/k8s/overlays/production

# 3. Lint and render the Helm chart (including NetworkPolicies)
helm lint deploy/helm/ecommerce-platform
helm template commerce-release deploy/helm/ecommerce-platform
```

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

## 9. Complete Inventory of Files

### Phase 5 New & Enhanced Files
* [`deploy/k8s/base/security/secret-store.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/security/secret-store.yaml) *(ESO SecretStore)*
* [`deploy/k8s/base/security/external-secrets.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/security/external-secrets.yaml) *(ESO ExternalSecret)*
* [`deploy/k8s/base/security/network-policies.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/security/network-policies.yaml) *(Zero-trust NetworkPolicies)*
* [`deploy/helm/ecommerce-platform/templates/networkpolicy.yaml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/helm/ecommerce-platform/templates/networkpolicy.yaml) *(Helm NetworkPolicy template)*
* [`scripts/security-audit.sh`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/scripts/security-audit.sh) *(Zero-trust audit script)*
* [`.github/workflows/ci.yml`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/.github/workflows/ci.yml) *(Added Trivy CVE scan and security-audit job)*
* [`package.json`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/package.json) *(Added npm run security:audit)*

### Phase 4 New Files Created
* K8s base manifests in [`deploy/k8s/base/`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/k8s/base/) and overlays (`staging`, `production`).
* Enterprise Helm chart in [`deploy/helm/ecommerce-platform/`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/helm/ecommerce-platform/).
* ArgoCD GitOps applications in [`deploy/argocd/`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/argocd/).
* Terraform IaC in [`deploy/terraform/`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/terraform/).

### Earlier Phases Files Created
* [`docs/DEVOPS_IMPLEMENTATION_LOG.md`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/docs/DEVOPS_IMPLEMENTATION_LOG.md)
* [`scripts/rabbitmq-dlq.ts`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/scripts/rabbitmq-dlq.ts)
* RabbitMQ DLQ spec & tracing specs in `apps/orders-service/test/` and `libs/rabbitmq/src/`.
* LGTM Observability stack in `docker-compose.observability.yml` and `observability/`.


