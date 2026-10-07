# DevOps & Production Engineering Roadmap

> **Target Architecture:** Scalable, observable, resilient production deployment for the 12-service e-commerce microservices platform.  
> **Current Stack:** 11 NestJS backend microservices, Next.js 16 storefront, RabbitMQ (event bus), Redis (cache/cart), OpenSearch (search projection), PostgreSQL (Neon DB per-service pattern).

---

## 1. System Topology & Current Baseline

```
                                      [ Internet / Shoppers ]
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │    Public Ingress (Port 443 / 80)     │
                             │  Cloudflare / Reverse Proxy / Caddy   │
                             └───────────┬───────────────┬───────────┘
                                         │               │
                        ┌────────────────┘               └────────────────┐
                        ▼                                                 ▼
          ┌───────────────────────────┐                     ┌───────────────────────────┐
          │   Storefront (Next.js)    │                     │   API Gateway (NestJS)    │
          │   Port 3100               │                     │   Port 3000               │
          └───────────────────────────┘                     └─────────────┬─────────────┘
                                                                          │
         ┌──────────────────┬─────────────────┬─────────────────┬─────────┴─────────┬──────────────────┐
         ▼                  ▼                 ▼                 ▼                   ▼                  ▼
   users-service      catalog-service   pricing-service   orders-service      payments-service   inventory-service
   (Port 3001)        (Port 3002)       (Port 3007)       (Port 3004)         (Port 3005)        (Port 3003)
         │                  │                 │                 │                   │                  │
         └──────────────────┴────────┬────────┴─────────────────┴───────────────────┴──────────────────┘
                                     │
                                     ▼  Event Bus & Projections
                     ┌───────────────────────────────┐
                     │    RabbitMQ (commerce.events) │
                     └───────┬───────────────┬───────┘
                             │               │
              ┌──────────────┴────────┐      └──────────────┬─────────────────────────┐
              ▼                       ▼                     ▼                         ▼
      shipping-service        search-service         reviews-service          recommendations-service
      (Port 3008)             (Port 3009)            (Port 3010)              (Port 3012)
                              OpenSearch (9200)      product_ratings (DB)     product_recommendations (DB)
```

---

## 2. The 5 Core Pillars

---

### Pillar 1: Distributed Tracing & Unified Observability (OTel + LGTM)

#### Problem
The Saga spans `orders-service` $\rightarrow$ `inventory-service` $\rightarrow$ `payments-service` $\rightarrow$ `shipping-service`. If checkout latency spikes or an order fails, grepping 15 independent container logs cannot reveal the root cause or the failing hop.

#### Architecture
* **Trace Propagation:** W3C `traceparent` headers injected on incoming HTTP gateway requests and forwarded over:
  * Inter-service HTTP calls (`x-correlation-id` and `traceparent`).
  * RabbitMQ message properties (`headers.traceparent`).
* **Collector:** OpenTelemetry Collector daemon.
* **Storage & Visualization (LGTM Stack):**
  * **Loki:** Log aggregation (structured JSON with `traceId` and `serviceName`).
  * **Tempo:** Distributed tracing waterfall graph.
  * **Prometheus:** Metrics collection (request rates, error rates, latencies, queue depths).
  * **Grafana:** Single dashboard correlating traces to logs and metrics.

#### Implementation Recipe
1. Add OpenTelemetry SDK in `@libs/common` or `instrumentation.ts`:
   ```ts
   import { NodeSDK } from '@opentelemetry/sdk-node';
   import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

   const sdk = new NodeSDK({
     traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
     instrumentations: [getNodeAutoInstrumentations()],
   });
   sdk.start();
   ```
2. Instrument RabbitMQ message publisher and consumer in `@libs/rabbitmq` to extract/inject trace context into message headers.

---

### Pillar 2: Intelligent Monorepo CI/CD & Build Optimization

#### Problem
Rebuilding all 12 Docker images on every Git commit burns compute credits and takes 15–20 minutes.

#### Architecture
* **Turborepo Change Detection:** Only build, lint, and test packages that changed relative to `origin/main`.
* **Multi-stage Docker with Remote BuildKit Caching:** GitHub Actions layer caching with GitHub Container Registry (GHCR) or AWS ECR.
* **Contract Verification:** Automated schema diff checks between `apps/*` Swagger output and `openapi/*.json`.

#### GitHub Actions Workflow Template (`.github/workflows/ci.yml`)
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  filter:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.changes.outputs.changes }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: changes
        with:
          filters: |
            catalog: 'apps/catalog-service/**'
            orders: 'apps/orders-service/**'
            recommendations: 'apps/recommendations-service/**'
            storefront: 'storefront/**'

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npx turbo run lint test --filter=...[origin/main]

  build-and-push:
    needs: [filter, test]
    strategy:
      matrix:
        service: ${{ fromJSON(needs.filter.outputs.services) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/${{ matrix.service }}-service/Dockerfile
          push: true
          tags: ghcr.io/${{ github.repository }}/${{ matrix.service }}-service:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

### Pillar 3: Infrastructure as Code (IaC) & Cloud Deployment

#### Problem
Manual infrastructure configuration causes drift and cannot scale dynamically across multiple cloud environments (Dev, Staging, Production).

#### Options Comparison

| Hosting Approach | Cost Profile | Complexity | Recommended For |
| :--- | :--- | :--- | :--- |
| **Option A: Single VPS (Hetzner / DO) + Coolify** | ~$15 – $25/mo | Low | MVPs, demos, portfolios, initial staging |
| **Option B: Managed PaaS (Railway / Render)** | ~$40 – $70/mo | Low | Fast team prototyping without server ops |
| **Option C: Kubernetes (AWS EKS / GCP GKE)** | ~$150 – $300+/mo | High | Enterprise production, auto-scaling, high traffic |

#### Kubernetes Manifest Blueprint (Per Service)
1. **Liveness & Readiness Probes:**
   * Mapped directly to existing endpoints:
     ```yaml
     livenessProbe:
       httpGet:
         path: /api/v1/health
         port: 3000
       initialDelaySeconds: 15
       periodSeconds: 10
     readinessProbe:
       httpGet:
         path: /api/v1/ready
         port: 3000
       initialDelaySeconds: 10
       periodSeconds: 5
     ```
2. **Resource Requests & Limits:**
   ```yaml
   resources:
     requests:
       memory: "180Mi"
       cpu: "100m"
     limits:
       memory: "384Mi"
       cpu: "500m"
   ```
3. **Horizontal Pod Autoscaling (HPA):**
   * Configured on `api-gateway` and `cart-service` to scale pods from 2 to 10 based on CPU > 70% or HTTP requests/sec.

---

### Pillar 4: Message Broker Resilience & Poison-Pill Prevention

#### Problem
If a consumer crashes on a malformed message, RabbitMQ will continuously reject or requeue, causing high CPU burn and blocking downstream consumers.

#### Implementation
1. **Dead Letter Exchange (DLX):**
   * Configure `commerce.dlx` (type: `direct` or `fanout`).
   * When declaring queues in `RabbitMQModule`:
     ```ts
     {
       durable: true,
       arguments: {
         'x-dead-letter-exchange': 'commerce.dlx',
         'x-dead-letter-routing-key': 'dead-letter',
         'x-max-delivery-count': 3, // Quarantine after 3 retries
       }
     }
     ```
2. **KEDA (Kubernetes Event-driven Autoscaling):**
   * Auto-scale worker pods based on RabbitMQ queue backlog:
     ```yaml
     apiVersion: keda.sh/v1alpha1
     kind: ScaledObject
     metadata:
       name: shipping-worker-scaler
     spec:
       scaleTargetRef:
         name: shipping-service-deployment
       minReplicaCount: 1
       maxReplicaCount: 5
       triggers:
       - type: rabbitmq
         metadata:
           queueName: shipping-service
           mode: QueueLength
           value: "50"
     ```

---

### Pillar 5: Zero-Trust Security & Secrets Management

#### Problem
Plaintext `.env` files risk leaking Stripe private keys, JWT secrets, and database credentials to version control.

#### Implementation
1. **Secret Store Integration:**
   * Use **AWS Secrets Manager** or **HashiCorp Vault**.
   * Deploy the **External Secrets Operator (ESO)** in Kubernetes to synchronize secrets into native Kubernetes secrets in-memory only.
2. **Static Secret Scanning:**
   * Enforce pre-commit and CI scans with `gitleaks`:
     ```bash
     gitleaks detect --source . --verbose
     ```
3. **Container Image Scanning:**
   * Run `trivy` in CI to fail builds that contain High/Critical CVE vulnerabilities in base Alpine/Node images:
     ```bash
     trivy image --severity HIGH,CRITICAL ghcr.io/...
     ```
4. **Network Policies (Egress / Ingress Isolation):**
   * Restrict access so only `api-gateway` can communicate with internal services on ports 3001–3012.
   * `payments-service` and `users-service` are isolated from external internet access except for authorized payment provider gateways (Stripe API).

---

## 3. Step-by-Step Implementation Timeline

| Phase | Focus Area | Deliverables | Status |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **CI/CD Optimization** | GitHub Actions path-filtering (`dorny/paths-filter@v3`), concurrency control, npm cache, multi-stage Docker build verification matrix (`docker/build-push-action@v5` + BuildKit cache), API contract and secret scanning. | **Completed** |
| **Phase 2** | **Distributed Tracing & Observability** | W3C `traceparent` (32-hex traceId / 16-hex spanId) & `x-correlation-id` context propagation via `AsyncLocalStorage` across Gateway, all 11 microservices, HTTP clients, and RabbitMQ message headers/outbox relay. Full LGTM stack (Loki, Tempo, Prometheus, Grafana) in `docker-compose.observability.yml`. | **Completed** |
| **Phase 3** | **Message Reliability & Resilience** | RabbitMQ Dead Letter Exchange (`commerce.dlx`) & Queues (`<queue>.dlq`), exponential backoff retry (1s, 2s, 4s), poison message quarantine with diagnostic headers, CLI redrive management tool (`npm run dlq:stats`, `dlq:replay`, `dlq:purge`). | **Completed** |
| **Phase 4** | **GitOps & Deployment** | Multi-environment K8s manifests (Kustomize base & overlays), enterprise Helm chart (`deploy/helm/ecommerce-platform`), KEDA event-driven autoscalers, HPA metrics, Terraform VPC/EKS/Redis IaC, ArgoCD automated GitOps pipelines. | **Completed** |
| **Phase 5** | **Zero-Trust Security & Secrets** | HashiCorp Vault / External Secrets Operator (ESO), Kubernetes zero-trust NetworkPolicies (default-deny, ingress/egress isolation, Stripe egress lockdown), Trivy container vulnerability scanner, and automated security audit suite (`npm run security:audit`). | **Completed** |

