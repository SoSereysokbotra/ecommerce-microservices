# Kubernetes Operational Runbook (M21)

> **Platform:** E-Commerce Microservices Platform  
> **Environment:** Local Multi-Node Kubernetes (k3d / K3s) & Helm  
> **Milestone:** Milestone 21 — Kubernetes, Helm, & Pod Auto-Scaling  
> **Core Acceptance Criterion (§8 R5 M21):** *"Whole stack runs on K8s; a killed pod self-heals."*

---

## 1. Architecture & Cluster Topology

```
                                  [ External Ingress / Browser ]
                                                │
                                                ▼ (HTTP Host Port 8080)
                             ┌─────────────────────────────────────┐
                             │       k3s Traefik LoadBalancer      │
                             └──────────────────┬──────────────────┘
                                                │
                                                ▼
                             ┌─────────────────────────────────────┐
                             │       api-gateway (ClusterIP:3000)  │
                             │       [Pod 1]        [Pod 2]        │  ◄── HPA (Min: 2, Max: 5, CPU: 70%)
                             └──────────────────┬──────────────────┘
                                                │
                ┌───────────────────┬───────────┴──────────┬───────────────────┐
                ▼                   ▼                      ▼                   ▼
         catalog-service     orders-service         payments-service     inventory-service
         (ClusterIP:3002)    (ClusterIP:3004)       (ClusterIP:3005)     (ClusterIP:3003)
            [1..5 Pods]         [1..5 Pods]             [1 Pod]             [1 Pod]
                │                   │                      │                   │
                └───────────────────┴───────────┬──────────┴───────────────────┘
                                                │
                                                ▼
                             ┌─────────────────────────────────────┐
                             │  RabbitMQ & Redis (ClusterIP)       │
                             │  PostgreSQL (Neon Cloud Managed DB) │
                             └─────────────────────────────────────┘
```

- **Cluster Engine:** `k3d` v5.9.0 running K3s v1.35.5 in Docker.
- **Topology:** 1 Control Plane (`k3d-commerce-cluster-server-0`) + 2 Worker Agents (`agent-0`, `agent-1`).
- **Namespace:** `commerce`
- **Ingress:** Traefik Ingress Controller mapped to host port `8080:80@loadbalancer`.
- **Infrastructure Services:** Redis 7 (ClusterIP:6379), RabbitMQ 3.13 (ClusterIP:5672, Management:15672).
- **Backend Microservices:** 12 NestJS services deployed via Helm (`api-gateway`, `users`, `catalog`, `inventory`, `orders`, `payments`, `cart`, `pricing`, `shipping`, `search`, `reviews`, `recommendations`).

---

## 2. Daily Cluster Lifecycle Operations

### Starting the Cluster
```powershell
k3d cluster start commerce-cluster
kubectl config use-context k3d-commerce-cluster
```

### Stopping the Cluster
To conserve host CPU and RAM when not developing:
```powershell
k3d cluster stop commerce-cluster
```

### Checking Cluster Health
```powershell
kubectl get nodes -o wide
kubectl get pods -n commerce
kubectl get svc -n commerce
kubectl get hpa -n commerce
```

---

## 3. Configuration & Secrets Management

- **ConfigMap (`commerce-config`):** Centralizes all internal service discovery endpoints (`http://catalog-service:3002`, `http://orders-service:3004`, etc.), logging levels, and broker URLs.
- **Secret (`commerce-secrets`):** Securely holds sensitive credentials (JWT secret, Stripe test keys, and per-service Neon PostgreSQL connection strings).

> [!IMPORTANT]
> Real credentials and database passwords must NEVER be committed to Git. `scripts/scan-secrets.sh` enforces this on every commit.

To patch or inspect secrets in the cluster:
```powershell
# Patch a secret key without editing files
kubectl patch secret commerce-secrets -n commerce --type=merge -p '{\"stringData\":{\"KEY_NAME\":\"value\"}}'
```

---

## 4. Building & Updating Production Container Images

Every backend microservice has a multi-stage Dockerfile with a standalone `--target production` build that pre-compiles TypeScript into JavaScript (`dist/`) and omits `devDependencies`.

### Building all Images locally
```powershell
$services = @("api-gateway", "users-service", "catalog-service", "inventory-service", "orders-service", "payments-service", "cart-service", "pricing-service", "shipping-service", "search-service", "reviews-service", "recommendations-service")
foreach ($s in $services) {
    docker build -t "commerce-$s:prod" -f "apps/$s/Dockerfile" --target production .
}
```

### Importing Images into k3d
Import directly into the cluster's local containerd runtimes:
```powershell
k3d image import `
  commerce-api-gateway:prod `
  commerce-users-service:prod `
  commerce-catalog-service:prod `
  commerce-inventory-service:prod `
  commerce-orders-service:prod `
  commerce-payments-service:prod `
  commerce-cart-service:prod `
  commerce-pricing-service:prod `
  commerce-shipping-service:prod `
  commerce-search-service:prod `
  commerce-reviews-service:prod `
  commerce-recommendations-service:prod `
  -c commerce-cluster --mode direct
```

---

## 5. Helm Chart Deployment & Rollout

The platform is packaged in [`deploy/helm/ecommerce-platform`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/deploy/helm/ecommerce-platform).

### Linting & Dry-Run Validation
```powershell
helm lint deploy/helm/ecommerce-platform
helm template ecommerce deploy/helm/ecommerce-platform -n commerce
```

### Upgrading the Helm Release
```powershell
helm upgrade ecommerce deploy/helm/ecommerce-platform -n commerce
```

### Checking Rollout Status
```powershell
kubectl rollout status deployment/ecommerce-ecommerce-platform-api-gateway -n commerce
```

---

## 6. Self-Healing & Zero-Downtime Updates

### Self-Healing Test (Killing a Pod)
To verify that Kubernetes automatically detects container death and resurrects a replacement pod:
```powershell
# 1. Note the current pod name
kubectl get pods -n commerce -l app=catalog-service

# 2. Force delete the active pod
kubectl delete pod <catalog-pod-name> -n commerce --grace-period=0 --force

# 3. Observe instant resurrection
kubectl get pods -n commerce -l app=catalog-service
```
*Result:* ReplicaSet immediately creates a new pod which passes readiness probes and resumes handling traffic.

### Zero-Downtime Rolling Update Test
The deployment strategy uses:
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```
This guarantees that an active replica is never terminated until a new surge replica has booted and passed its readiness probe.

Test zero downtime during rollout:
```powershell
kubectl rollout restart deployment/ecommerce-ecommerce-platform-api-gateway -n commerce
1..15 | ForEach-Object {
    curl.exe -s http://localhost:8080/api/v1/health
    Start-Sleep -Milliseconds 400
}
```
*Result:* All 15 requests return `200 OK` (`{"status":"ok","service":"api-gateway"}`) with zero dropped requests.

---

## 7. Horizontal Pod Autoscaler (HPA)

The Horizontal Pod Autoscalers monitor CPU and Memory utilization via `metrics-server`:
- `api-gateway`: Min 2, Max 5 (Target: CPU 70%, Memory 80%)
- `catalog-service`: Min 1, Max 5 (Target: CPU 70%)
- `orders-service`: Min 1, Max 5 (Target: CPU 70%)
- `cart-service`: Min 1, Max 5 (Target: CPU 70%)

Inspect live HPA metrics:
```powershell
kubectl get hpa -n commerce
```

---

## 8. Troubleshooting & Diagnostics

| Symptom | Probable Cause | Remediation |
| :--- | :--- | :--- |
| `CrashLoopBackOff` | Database relation already exists | Verify migration uses `ifNotExists: true` and `CREATE INDEX IF NOT EXISTS`. |
| `Missing: OPENSEARCH_URL` | ConfigMap variable mismatch | Ensure `commerce-config` defines `OPENSEARCH_URL`. |
| `TLS handshake timeout` on `kubectl` | `host.docker.internal` resolved to Wi-Fi IP blocked by Windows firewall | Run `kubectl config set-cluster k3d-commerce-cluster --server=https://127.0.0.1:51338 --insecure-skip-tls-verify=true`. |
| Pod stuck in `Pending` | Resource limits exceeded on cluster nodes | Review `kubectl describe nodes` and verify replica count and memory requests. |
| `503 Service Unavailable` on Gateway | Service name mismatch in Helm | Ensure service is named cleanly (e.g., `catalog-service`) matching `commerce-config`. |
