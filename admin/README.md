# Admin Dashboard & Operations Console

Back-office operations portal for the commerce microservices platform. Built with Next.js (App Router), React 19, and vanilla CSS design tokens. Runs on port 3200.

## Overview

The admin dashboard provides operational interfaces for store managers, customer service staff, and system administrators to manage the complete commerce lifecycle without requiring manual database or terminal access:

- **Operations Overview (`/`):** Real-time KPI summary (total revenue, active orders, low-stock warnings, pending reviews) and a live mesh health matrix monitoring all 11 microservices.
- **Order Operations & Fulfillment (`/orders`):** Filter orders by status, inspect item breakdowns and addresses, trigger carrier dispatch with tracking codes, record deliveries, and issue Stripe refunds.
- **Product Catalog Management (`/catalog`):** Product authoring, category management, price updates in integer minor units, and status controls (`ACTIVE`, `DRAFT`, `ARCHIVED`).
- **Warehouse Stock Management (`/inventory`):** Real-time stock audit, delta-based stock adjustments with audit log reasons, and absolute stock replenishment.
- **User Directory & RBAC (`/users`):** Customer directory search, role assignment (`ADMIN`, `STAFF`, `CUSTOMER`), and account suspension.
- **Review Moderation (`/reviews`):** Queue of customer reviews, verified-purchase indicators, and one-click publish/reject actions triggering rating rollups.
- **Promotions & Coupons (`/coupons`):** Create and inspect promo codes with usage limits, expiry windows, and discount calculations.
- **System Maintenance & Mesh Replays (`/system`):** Admin-only console to execute 3-step OpenSearch catalog reindexing, rebuild recommendation co-purchase graphs, and monitor mesh health.

## Running Locally

```bash
# Start backend stack (if not already running)
npm run dev:stack

# Launch Admin Dashboard
npm run dev:admin       # http://localhost:3200
```

### Environment Variables

Configure `.env.local` (or copy `.env.local.example`):

- `NEXT_PUBLIC_API_URL` — Base URL of the API Gateway, default `http://localhost:3000/api/v1`.

All API requests flow strictly through the API Gateway on port 3000. W3C `traceparent` and `x-correlation-id` headers are automatically injected on every client request for end-to-end distributed tracing.

## Access Control & Authentication

The portal enforces client-side and server-side RBAC:

- **Staff (`STAFF`):** Can view orders, update fulfillment statuses, manage catalog items, and moderate reviews.
- **Admin (`ADMIN`):** Full privileges including user role changes, financial refunds, and system maintenance replays (`/system`).
- **Customer / Unauthenticated:** Routed to `/login` or blocked by `<AuthGate>`.

## Automated Testing

```bash
# Run Playwright E2E test suite
npm run test:admin
```
