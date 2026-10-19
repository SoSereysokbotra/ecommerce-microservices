# Distributed Systems & Cloud-Native Engineering Concepts
> Comprehensive reference guide covering Orchestration, Service Discovery, Infrastructure as Code, API Protocols, and Service Meshes.

---

## 1. Container Orchestration: Docker Compose vs. K3s vs. K8s

> **Terminology Note:** "K8b" and "K8c" are common keyboard typos for **K8s** (short for **K-ubernete-s**, where "8" represents the eight letters between 'K' and 's').

```
Scale & Complexity:
[ Docker Compose ]  ────────►  [ K3s (Lightweight) ]  ────────►  [ Full K8s (Enterprise) ]
Single Host / Laptop           Edge / IoT / Small Team            Multi-Cloud / Large Scale
```

| Feature | Docker Compose | K3s (Lightweight K8s) | K8s (Full Kubernetes) |
| :--- | :--- | :--- | :--- |
| **Primary Scope** | Single-host multi-container runner | Lightweight multi-node orchestrator | Enterprise-grade multi-node orchestrator |
| **Target Environment** | Local dev, simple VPS, CI tests | Edge, IoT, small/medium clusters, dev | Large-scale, cloud-native enterprise production |
| **Cluster / Multi-Node** | ❌ No (runs on 1 Docker engine) |  Yes (lightweight multi-node) |  Yes (thousands of nodes) |
| **Resource Overhead** | Minimal (native Docker engine) | Very low (~512MB RAM, binary < 100MB) | High (requires multi-GB RAM control plane) |
| **Under the Hood** | Docker daemon | Single binary, SQLite default DB | Distributed etcd, API server, controller |
| **Configuration** | `docker-compose.yml` | Standard K8s manifests / Helm | Standard K8s manifests / Helm |
| **Self-Healing** | Container restart (`restart: always`) | Reschedules pods across failed nodes | Advanced multi-zone HA, auto-scaling |

### When to Use Which:
* **Docker Compose:** Use when running containers on your own laptop or a single test server.
* **K3s:** Use when you want full Kubernetes API compatibility on low-resource machines (Raspberry Pi, small cloud VPS, edge devices).
* **K8s:** Use for mission-critical enterprise production with auto-scaling, multi-zone failover, and high traffic (e.g., AWS EKS, Google GKE).

---

## 2. Microservice Service Discovery

### The Core Problem: Dynamic Ephemeral IPs
In traditional architectures, servers had static IP addresses (e.g., `192.168.1.10:5432`). In modern microservices (Docker & Kubernetes):
* Containers constantly restart, crash, scale up, or move between host nodes.
* Every time a container restarts, it gets a **brand new, randomly assigned IP address**.
* **Service Discovery** is the automated mechanism that allows microservices to locate and communicate with each other dynamically without hardcoding IP addresses.

### The Real-World Analogy: The Smart Phonebook
* **Without Service Discovery:** Every time your friend Bob moves and changes his phone number, you must ask him for his new number and manually update your address book. If he moves while you are calling him, your call drops.
* **With Service Discovery:** Bob reports his new number to a live directory. You simply click **"Call Bob"**. The directory automatically connects you to whatever number Bob currently has.

```
                  [ Service Registry / DNS ("Phonebook") ]
                  │   catalog-service  ──►  172.18.0.4:3002
                  │   orders-service   ──►  172.18.0.5:3004
                  ▲                                    ▲
     (1) Registers│                         (2) Resolves
                  │                                    │
       [ Catalog Service ]                    [ API Gateway ]
       (boots with new IP)                fetch("http://catalog-service")
```

### How Service Discovery is Implemented in This Project:
Many online Java/Spring Boot tutorials teach students to build a separate `eureka-server` (Netflix Eureka). **Modern containerized systems do not need Eureka.** Docker and Kubernetes provide native, DNS-based service discovery out of the box:

1. **In Local Development (`docker-compose.yml`):**
   * All containers share the `networks: [commerce]` bridge.
   * Docker runs an embedded DNS server (`127.0.0.11`).
   * When `api-gateway` calls `http://catalog-service:3002`, Docker’s DNS resolves `catalog-service` to the container's active internal IP automatically.
2. **In Production (`deploy/k8s/`):**
   * Every microservice defines a Kubernetes `Service` with `type: ClusterIP`.
   * Kubernetes **CoreDNS** and **`kube-proxy`** automatically route calls (`http://catalog-service:3002`) to healthy pod replicas and update endpoints during autoscaling.

---

## 3. Infrastructure as Code (IaC): Terraform

**Terraform** (by HashiCorp) is an **Infrastructure as Code (IaC)** tool that lets you provision and manage cloud infrastructure (servers, VPC networks, databases, Kubernetes clusters) using declarative configuration files (`.tf`) instead of manually clicking buttons inside cloud web consoles.

### Manual Cloud Setup vs. Terraform Code

| Manual Clicking (AWS / GCP Console) | Terraform (`deploy/terraform/main.tf`) |
| :--- | :--- |
| Click 100+ buttons across multiple screens | Write declarative code: `resource "aws_vpc" {}` |
| Prone to human errors & missed checkboxes | Exact, repeatable, and consistent execution |
| "Black Box" — invisible to teammates, Git, and AI | **Single Source of Truth** saved and tracked in GitHub |
| Re-building for Staging/Prod takes hours | `terraform apply` builds everything in minutes |

### The Core Terraform Workflow:
```
1. terraform init     ──► Downloads cloud provider plugins (AWS, Azure, GCP)
2. terraform plan     ──► Generates a dry-run preview diff of what will be created/changed
3. terraform apply    ──► Connects to the cloud and creates the resources
4. terraform destroy  ──► Teardown and delete all cloud resources to avoid billings
```

---

## 4. Communication Protocols: REST vs. gRPC

```
              Client Browser / Mobile App
                         │
                         │ (REST / JSON over HTTP/1.1 or HTTP/2)
                         ▼
                   [ API Gateway ]
                    │          │
                    │ (gRPC)   │ (gRPC)  ──► Protocol Buffers / Binary over HTTP/2
                    ▼          ▼
             [Orders-Svc]   [Payments-Svc]
```

### REST (Representational State Transfer)
* **What it is:** An architectural style based on **Resources (nouns)** and **HTTP Verbs (actions)**.
* **Core Philosophy:** URLs represent things (`/products`, `/orders`), and HTTP methods represent actions (`GET`, `POST`, `PATCH`, `DELETE`).
* **Format:** Plain text human-readable **JSON**.
* **Strength:** Universal browser support, easy to debug in browser DevTools and Postman.

### gRPC (Google Remote Procedure Call)
* **What it is:** A high-performance RPC framework created by Google where calling a remote service looks like invoking a local function in code (e.g., `paymentService.processPayment(req)`).
* **Format:** **Protocol Buffers (Protobuf)** — ultra-compact, strongly typed binary format (0s and 1s).
* **Transport:** Strictly **HTTP/2** with connection multiplexing and bidirectional streaming.
* **Strength:** 5x to 10x faster serialization than JSON, low CPU usage, low network latency, strict `.proto` contracts.

### REST vs. gRPC Direct Comparison:

| Feature | REST | gRPC |
| :--- | :--- | :--- |
| **Payload Format** | JSON (Plain text, string keys repeated) | Protocol Buffers (Binary, compact integers) |
| **Transport** | HTTP/1.1 or HTTP/2 | HTTP/2 (Always) |
| **Streaming** | Limited (Server-Sent Events / WebSockets) | Full bi-directional streaming natively |
| **API Contract** | Optional (OpenAPI / Swagger) | **Mandatory** (`.proto` interface definition) |
| **Browser Support**| 100% native in every browser | Requires a translation proxy (`grpc-web`) |
| **Primary Use** | Public APIs, Browser-to-Backend | Internal Microservice-to-Microservice |

---

## 5. Modern Mesh Networking: Service Mesh, Envoy & Sidecar Pattern

### The Problem: The "Fat Library" Dilemma
In a large microservices architecture (e.g., 20+ services), every service needs:
1. **Mutual TLS (mTLS):** Encrypting internal network traffic.
2. **Resilience:** Automatic retries, circuit breaking, timeouts.
3. **Observability:** Distributed tracing headers, latency histograms.
4. **Traffic Splitting:** Canary releases (e.g., send 5% traffic to v2, 95% to v1).

Without a service mesh, developers had to write this networking code into every application repo. If your services are written in multiple languages (TypeScript, Go, Java, Python), you had to duplicate and maintain those libraries in every language!

---

### What is a Service Mesh?
A **Service Mesh** is a dedicated infrastructure layer that extracts networking, security, and traffic control **completely out of application code**.

Your code writes clean business logic:
```ts
// Application code doesn't care about retries, mTLS, or tracing:
await http.get('http://payments-service/charge');
```
The Service Mesh invisibly handles the encryption, certificate rotation, retries, and distributed tracing.

---

### What is Envoy Proxy?
**Envoy** is a high-performance, open-source edge and service proxy written in **C++** (originally built by Lyft, now a CNCF graduated project).
* Handles HTTP/1.1, HTTP/2, and **gRPC** natively.
* Extremely low memory footprint and sub-millisecond routing latency.
* **Envoy is the actual "engine" (Data Plane) powering modern service meshes like Istio.**

---

### The Sidecar Pattern: The Motorcycle Analogy
In Kubernetes, a **Pod** can run more than one container sharing the same network namespace (`localhost`).

* **The Motorcycle:** Your application container (`orders-service`).
* **The Sidecar:** An Envoy proxy container running beside your app in the same Pod.

```
┌── [Orders Pod] ──────────────────────────┐              ┌── [Payments Pod] ────────────────────────┐
│                                          │              │                                          │
│   [ Orders App (Node.js) ]               │              │   [ Payments App (Go) ]                  │
│              │                           │              │              ▲                           │
│       (local traffic)                    │              │       (local traffic)                    │
│              ▼                           │              │              │                           │
│    [ Envoy Sidecar Proxy ]               │              │    [ Envoy Sidecar Proxy ]               │
└──────────────┬───────────────────────────┘              └──────────────▲───────────────────────────┘
               │                                                         │
               └─────────────── Encrypted mTLS Network Wire ─────────────┘
                               • Mutual TLS Encryption
                               • Automatic Retries & Circuit Breaking
                               • W3C Distributed Tracing Injection
                               • gRPC HTTP/2 Load Balancing
```

1. `orders-service` makes a request to `payments-service`.
2. The local **Envoy sidecar intercepts the call** on `localhost`.
3. Envoy handles mTLS encryption, adds trace headers, and load balances across healthy payment pods.
4. The destination Envoy sidecar decrypts the payload and delivers it locally to the `payments-service` application.

---

### Data Plane vs. Control Plane

A complete Service Mesh is divided into two distinct responsibilities:

```
[ Control Plane (e.g., Istio) ]
  • Central headquarters: Admins write routing & security policies
  • Distributes TLS certificates and configs to all proxies
        │
        ▼ (Pushes configuration)
┌──────────────────────────────────────────────┐
│  Data Plane (Envoy Sidecars)                 │
│  • Actual worker proxies running in pods     │
│  • Intercepts, encrypts, and forwards packets│
└──────────────────────────────────────────────┘
```

| Component | Example Technology | Role | Analogy |
| :--- | :--- | :--- | :--- |
| **Data Plane** | **Envoy** | Moves data packets, encrypts wire traffic, collects metrics. | The armored security trucks transporting cargo. |
| **Control Plane** | **Istio**, Linkerd | Central management, pushes configuration rules and TLS certs. | The central headquarters commanding the fleet. |

---

## 6. Summary: The Modern Cloud-Native Stack

```
Layer                  Technology               Responsibility
─────────────────────────────────────────────────────────────────────────────────────────────
Cloud Infrastructure   Terraform / OpenTofu     Provisions AWS VPC, Subnets, EKS clusters
Orchestration          Kubernetes (K8s) / K3s   Schedules, scales, and heals container pods
Service Mesh           Istio + Envoy (Sidecar)  Zero-code mTLS, retries, and gRPC load balancing
Service Discovery      Kube-DNS / CoreDNS       Resolves service names to active dynamic IPs
Edge Gateway           API Gateway (Reverse)    Authentication, rate limiting, and public ingress
Internal Communication gRPC (Protobuf, HTTP/2)  Ultra-fast binary RPC for backend-to-backend calls
External Communication REST (JSON, HTTP/1.1)    Standard public API for web & mobile clients
Event Streaming        RabbitMQ / Kafka         Asynchronous outbox messaging & event-driven sagas
