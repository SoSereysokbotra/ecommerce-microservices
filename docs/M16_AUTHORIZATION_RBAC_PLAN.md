# M16 — Role-Based Access Control (RBAC) & Back-Office Authorisation Plan

**Written:** 2026-10-15  
**Status:** Draft / Pending User Approval  
**Milestone:** M16 — Authorisation & Operational Permissions (R4 Operations & Hardening)  
**Parent Plan:** `docs/PROJECT_PLAN.md` (§8, R4 M16)  

---

## 1. Executive Summary & Goals

In **M15**, we hardened **Authentication & Session Security**: device-aware sessions, token rotation breach detection, remote session revocation, and cryptographic password resets. Authentication answers: *"Who is calling?"*

**M16 addresses Authorisation**: *"What is the caller permitted to see and do?"*

Prior to M16, any client with a valid JWT could call internal endpoints provided they supplied a bearer token or session cookie. This left critical architectural gaps:
1. **Vertical Privilege Escalation**: Regular customers could call staff-only or admin-only routes (e.g. creating/updating products in `catalog-service`, replaying sagas in `orders-service`, adjusting warehouse stock in `inventory-service`, moderating reviews in `reviews-service`, or rebuilding search indices).
2. **Horizontal Privilege Escalation (IDOR)**: Without strict caller-ownership scoping, a malicious user could inspect another customer's orders or saved addresses if the database query did not bind `WHERE customer_id = :callerId`.
3. **Missing Administrative Operations**: Staff and administrators currently have no dedicated query filters to view all customer orders, manage user statuses/roles, or execute support overrides.

M16 systematically resolves these debts by introducing a production-grade, multi-tier RBAC framework across `libs/common`, `api-gateway`, and all downstream domain microservices.

---

## 2. Settled Architectural Decisions

| Decision | Selection | Rationale |
| :--- | :--- | :--- |
| **Role Hierarchy** | `customer` < `staff` < `admin` | Defined in `UserRole` enum (`libs/shared-types`). `customer` is limited to self-owned data. `staff` manages operations (catalog, inventory, order fulfillment, moderation). `admin` has full rights (promotions, bans, refunds, system configurations). |
| **Enforcement Mechanism** | Gateway Perimeter + In-Service `@Roles()` Guard | Dual-layer security: (1) API Gateway fast-rejects forbidden route attempts at the perimeter, and (2) Downstream services enforce `@Roles(...)` via `RolesGuard` using the gateway-verified `x-user-role` header. |
| **Fail-Closed Default** | Missing/Invalid Role = `403 Forbidden` | If a protected endpoint specifies required roles and the caller's role is missing, unrecognized, or insufficient, the request is immediately rejected. |
| **Query Ownership Scoping** | Customer: strict filter; Staff/Admin: bypass | When a customer calls `GET /orders` or `GET /orders/:id`, the query strictly binds `customer_id = :callerId` (returns 404/empty rather than 403 to prevent record enumeration). When staff/admin calls the endpoint, ownership filtering is relaxed. |
| **Downstream Trust Contract** | Gateway is the Single Source of Identity | Downstream microservices trust `x-user-id` and `x-user-role` because the API Gateway unconditionally strips client-sent identity headers before writing verified values from the validated JWT/session. |

---

## 3. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       HTTP REQUEST (Cookie or Bearer)                       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API GATEWAY (:3000)                              │
│  1. GatewayJwtGuard: Verify JWT & Redis session status (<0.5ms)             │
│  2. GatewayRolesGuard / Path Policy: Perimeter block for /admin/* routes    │
│  3. ProxyService: Strip client headers, inject x-user-id & x-user-role      │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
       Forwarded with  │ x-user-id                     │ Forwarded with
       x-user-role     │                               │ x-user-role
                       ▼                               ▼
┌───────────────────────────────┐             ┌───────────────────────────────┐
│     CATALOG-SERVICE (:3002)   │             │     ORDERS-SERVICE (:3004)    │
│  @Roles('admin', 'staff')     │             │  GET /orders/:id              │
│  POST /catalog/products       │             │  - customer: WHERE user = me  │
│  PATCH /catalog/products/:id  │             │  - admin/staff: WHERE id = :id│
└───────────────────────────────┘             └───────────────────────────────┘
                       │                               │
                       ▼                               ▼
┌───────────────────────────────┐             ┌───────────────────────────────┐
│    INVENTORY-SERVICE (:3003)  │             │     USERS-SERVICE (:3001)     │
│  @Roles('admin', 'staff')     │             │  @Roles('admin')              │
│  POST /stock/adjust           │             │  PATCH /users/:id/role        │
│  POST /stock/replenish        │             │  PATCH /users/:id/status      │
└───────────────────────────────┘             └───────────────────────────────┘
```

---

## 4. Phased Implementation Roadmap

In accordance with our project operating rules, work is strictly organized into sequential phases. Each phase is independently implemented, thoroughly tested, committed, and pushed before proceeding.

```
Phase 1: Common RBAC Primitives (@Roles, RolesGuard, UserRole enum)
    │
    ▼
Phase 2: Users Service Administrative API & Role Management
    │
    ▼
Phase 3: Catalog & Inventory Back-Office Endpoint Protection
    │
    ▼
Phase 4: Orders & Reviews Caller Ownership Scoping & Staff Overrides
    │
    ▼
Phase 5: Search, Recommendations & Shipping Admin Action Lockdown
    │
    ▼
Phase 6: Gateway Perimeter Policy, Automated Security Matrix Tests & Runbook
```

---

### Phase 1: Common RBAC Primitives (`libs/common`)
**Goal:** Create standard, framework-wide decorators, guards, and interfaces for role enforcement.

- **Tasks:**
  1. Add `@Roles(...roles: UserRole[])` decorator in `libs/common/src/decorators/roles.decorator.ts`.
  2. Implement `RolesGuard` in `libs/common/src/guards/roles.guard.ts`:
     - Reads route metadata using `Reflector`.
     - Extracts `x-user-role` header from `req.headers['x-user-role']` (or `req.user.role`).
     - Validates role against required roles (e.g. `roles.includes(userRole)`).
     - Fail-closed: Throws `ForbiddenException('Insufficient permissions')` if unauthorized.
  3. Update `CorrelationIdMiddleware` to populate `req.user = { id: rawUserId, role: rawUserRole }` on incoming requests for easy injection via `@CurrentUser()`.
  4. Export all RBAC decorators and guards in `libs/common/src/index.ts`.
  5. Add unit tests for `RolesGuard` covering:
     - Route without `@Roles` (allows access).
     - Route with matching role (allows access).
     - Route with non-matching role (throws 403 Forbidden).
     - Request with missing `x-user-role` header (throws 403 Forbidden).

---

### Phase 2: Users Service Administrative API & Role Management (`users-service`)
**Goal:** Provide secure endpoints for admins to list users, change roles, and manage account statuses (`ACTIVE`, `SUSPENDED`, `BANNED`), while preventing self-privilege escalation.

- **Tasks:**
  1. Implement DTOs: `UpdateUserRoleDto` (`role: UserRole`), `UpdateUserStatusDto` (`status: UserStatus`).
  2. Add Admin endpoints to `UsersController`:
     - `GET /users`: Paginated listing of users with query filters (`role`, `status`, `search`). Guarded by `@Roles(UserRole.ADMIN, UserRole.STAFF)`.
     - `PATCH /users/:id/role`: Update user role (`ADMIN` only). Prohibits an admin from revoking their own admin privileges to avoid system lockout.
     - `PATCH /users/:id/status`: Update user lifecycle status (`ADMIN` only). When an account is suspended or banned, automatically revoke all active sessions in Redis and DB.
  3. Ensure `AddressesController` & `AddressesService` strictly scope address operations to `customerId === callerId`, with support for admin override.
  4. Write comprehensive unit and integration tests.

---

### Phase 3: Catalog & Inventory Back-Office Endpoint Protection (`catalog-service`, `inventory-service`)
**Goal:** Secure catalog mutations and stock adjustments behind staff/admin roles.

- **Tasks:**
  1. **`catalog-service`**:
     - Attach `RolesGuard` and `@Roles(UserRole.ADMIN, UserRole.STAFF)` to:
       - `POST /catalog/products` (Create product).
       - `PATCH /catalog/products/:id` (Update product).
       - `POST /catalog/categories` (Create category).
       - `PATCH /catalog/categories/:id` (Update category).
       - `POST /catalog/admin/republish` (Republish search events).
     - Verify public browsing routes (`GET /catalog/products`, `GET /catalog/products/:idOrSlug`) remain `@Public()`.
  2. **`inventory-service`**:
     - Attach `RolesGuard` and `@Roles(UserRole.ADMIN, UserRole.STAFF)` to stock adjustment endpoints:
       - `POST /inventory/stock/adjust`
       - `POST /inventory/stock/replenish`
     - Stock reservation during checkout remains accessible for internal order saga service calls.
  3. Add unit tests verifying 403 Forbidden on unauthorized roles.

---

### Phase 4: Orders & Reviews Caller Ownership Scoping & Staff Overrides (`orders-service`, `reviews-service`)
**Goal:** Prevent horizontal cross-customer data leakage (IDOR) while giving staff and admins the required visibility for support and fulfillment.

- **Tasks:**
  1. **`orders-service`**:
     - Update `OrdersController.list()`:
       - If caller is `CUSTOMER`: List only caller's orders (`WHERE customer_id = :callerId`).
       - If caller is `STAFF` or `ADMIN`: Allow listing all orders or filtering by optional `?customerId=...`.
     - Update `OrdersController.findOne()`:
       - If caller is `CUSTOMER`: Find order where `id = :id AND customer_id = :callerId`. Return 404 if not found.
       - If caller is `STAFF` or `ADMIN`: Find order where `id = :id` regardless of customer.
     - Protect `POST /orders/admin/replay` with `@Roles(UserRole.ADMIN, UserRole.STAFF)`.
  2. **`reviews-service`**:
     - Customer routes: `POST /reviews` (create review, verify caller purchased).
     - Protect moderation routes in `ModerationController`:
       - `GET /reviews/moderation/pending` -> `@Roles(UserRole.ADMIN, UserRole.STAFF)`
       - `PATCH /reviews/:id/moderation` -> `@Roles(UserRole.ADMIN, UserRole.STAFF)`
  3. Add unit tests for ownership scoping and staff access.

---

### Phase 5: Search, Recommendations, Shipping & Pricing Lockdown
**Goal:** Secure operations endpoints across remaining services that were previously noted as "M16 debt".

- **Tasks:**
  1. **`search-service`**:
     - Protect `POST /search/admin/recreate-index` with `@Roles(UserRole.ADMIN)`.
  2. **`recommendations-service`**:
     - Protect `POST /recommendations/admin/rebuild` with `@Roles(UserRole.ADMIN)`.
  3. **`shipping-service`**:
     - Protect shipment dispatch and delivery status mutations (`POST /shipments/:id/dispatch`, `POST /shipments/:id/deliver`) with `@Roles(UserRole.ADMIN, UserRole.STAFF)`.
  4. **`pricing-service`**:
     - Protect coupon creation, modification, and deletion (`POST /pricing/coupons`, `DELETE /pricing/coupons/:code`) with `@Roles(UserRole.ADMIN)`.
     - Protect tax rate modifications with `@Roles(UserRole.ADMIN)`.

---

### Phase 6: Gateway Perimeter Policy, Automated Security Matrix Tests & Runbook
**Goal:** Verify entire security perimeter end-to-end and document operational curl runbooks.

- **Tasks:**
  1. **Gateway Perimeter Check**:
     - In `api-gateway`, ensure routes matching `/admin/*` reject unauthorized clients early if desired, or let granular service guards handle it cleanly.
  2. **Automated Security Matrix Test**:
     - Matrix tests across roles:
       - `ANONYMOUS` -> Protected routes return 401.
       - `CUSTOMER` -> Admin routes return 403; other customers' data returns 404.
       - `STAFF` -> Operational routes return 200; Admin-only routes return 403.
       - `ADMIN` -> All routes return 200.
  3. Update verification checklist and runbook with reproducible `curl` commands.
  4. Run git secret audit (`bash scripts/scan-secrets.sh`) before final delivery.

---

## 5. Definition of Done for M16

- [x] All 6 phases implemented and committed sequentially with clear git messages.
- [x] No regression on existing E2E cart, order, and payment flows.
- [x] Automated tests pass across all services (`npm test` in each touched app and `security-matrix.spec.ts`).
- [x] Zero hardcoded secrets committed (`scripts/scan-secrets.sh` passes).
- [x] User reviews and explicitly approves each phase before the next is executed.

---

## 6. Operational Security Runbook (curl Verification)

The following commands verify the zero-trust perimeter, role-based access control, IDOR scoping, and admin self-protection against the running stack via API Gateway (`http://localhost:3000`).

### 1. Acquire Access Tokens
```bash
# Customer login
CUSTOMER_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r '.accessToken')

# Staff login
STAFF_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"staff@example.com","password":"Password123!"}' | jq -r '.accessToken')

# Admin login
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Password123!"}' | jq -r '.accessToken')
```

### 2. Verify Anonymous Perimeter (Expect 401 Unauthorized)
```bash
# Attempt to access protected endpoint without authentication
curl -i -X GET http://localhost:3000/api/v1/orders
# Expected: HTTP/1.1 401 Unauthorized
```

### 3. Verify Customer Role Authorization & IDOR Protection
```bash
# Customer accessing back-office user management (Expect 403 Forbidden)
curl -i -X GET http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $CUSTOMER_TOKEN"
# Expected: HTTP/1.1 403 Forbidden

# Customer accessing product mutation (Expect 403 Forbidden)
curl -i -X POST http://localhost:3000/api/v1/catalog/products \
  -H "Authorization: Bearer $CUSTOMER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hacked Product","priceMinor":100}'
# Expected: HTTP/1.1 403 Forbidden

# Customer accessing other customer's order (IDOR test: Expect 404 Not Found, not 200 or leak)
curl -i -X GET http://localhost:3000/api/v1/orders/00000000-0000-0000-0000-000000000999 \
  -H "Authorization: Bearer $CUSTOMER_TOKEN"
# Expected: HTTP/1.1 404 Not Found
```

### 4. Verify Staff Role Permissions & Boundaries
```bash
# Staff accessing operations: stock adjustment (Expect 200 OK)
curl -i -X POST http://localhost:3000/api/v1/inventory/stock/prod-1/adjust \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantityDelta":10,"reason":"restock"}'
# Expected: HTTP/1.1 200 OK

# Staff accessing operations: shipment dispatch (Expect 200 OK)
curl -i -X POST http://localhost:3000/api/v1/shipping/shipments/ship-1/dispatch \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"carrier":"DHL","trackingCode":"DHL98765"}'
# Expected: HTTP/1.1 200 OK

# Staff attempting admin-only privilege: change user role (Expect 403 Forbidden)
curl -i -X PATCH http://localhost:3000/api/v1/users/user-123/role \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
# Expected: HTTP/1.1 403 Forbidden
```

### 5. Verify Admin Role Permissions & Self-Demotion Lockout Guard
```bash
# Admin listing users (Expect 200 OK)
curl -i -X GET http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expected: HTTP/1.1 200 OK

# Admin creating coupon (Expect 201/200 OK)
curl -i -X POST http://localhost:3000/api/v1/pricing/coupons \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"VIP50","discountId":"disc-uuid","maxUses":100}'
# Expected: HTTP/1.1 201 Created

# Admin self-demotion lockout guard (Expect 400 Bad Request)
# When admin attempts to revoke their own admin role:
curl -i -X PATCH http://localhost:3000/api/v1/users/admin-own-uuid/role \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"customer"}'
# Expected: HTTP/1.1 400 Bad Request ("Admins cannot demote their own account")
```

