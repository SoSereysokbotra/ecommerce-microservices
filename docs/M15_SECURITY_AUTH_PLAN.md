# M15 — Enterprise Authentication & Session Security Plan

**Written:** 2026-10-14  
**Status:** Approved for Implementation (Phased Execution)  
**Milestone:** M15 — Security & Identity Modernization  
**Inspiration:** `D:\Year2\Angkoro\Angkoro-Backend\src\core\auth` (Adapted for Distributed Microservices without Telegram)

---

## 1. Executive Summary & Goals

The current authentication system in `ecommerce-microservices` uses basic stateless JWTs:
* Tokens cannot be revoked before their 1-hour expiration.
* Stolen laptops or compromised tokens cannot be locked out remotely.
* Refresh tokens are stored in the browser's `localStorage` (vulnerable to XSS theft).
* The user database table lacks account security lifecycle statuses (`ACTIVE`, `SUSPENDED`, `BANNED`).
* A `user_sessions` migration was previously created in `apps/users-service`, but remains completely unmapped and unused by the application.

This plan brings the **production-grade authentication and session security architecture from Angkoro-Backend** into `ecommerce-microservices` while preserving microservice performance and independence.

---

## 2. Settled Architectural Decisions

Based on user requirements and architectural audit:

| Decision | Selection | Rationale |
| :--- | :--- | :--- |
| **Feature Scope** | Full Security Suite (excluding Telegram) | Device-aware sessions (`sid`), remote session revocation, SHA-256 hashed refresh tokens, account lifecycle statuses, and cryptographic password resets. |
| **Token Transport** | `httpOnly` Cookies + Bearer fallback | Browser cookies prevent XSS token theft. Storefront (`http://localhost:3011`) and Gateway (`http://localhost:3000`) communicate via cross-origin CORS with `credentials: true`. Bearer token fallback is preserved for headless API clients. |
| **Database Strategy** | Fresh Database Reset | Recreate the schema in `users-service` cleanly from scratch so all tables, foreign keys, and status enums are production-grade without migration clutter. |
| **Session Verification** | Redis + PostgreSQL Hybrid | PostgreSQL stores persistent session audit history. Active session states (`session:<sid> = "active"`) are cached in Redis. The API Gateway verifies sessions in **<0.5ms** without touching PostgreSQL or making cross-service HTTP calls. |
| **Downstream Compatibility** | Strict Identity Header Contract | Downstream microservices (`orders-service`, `cart-service`, `reviews-service`) remain untouched. The API Gateway continues stripping client-supplied `x-user-id` and injecting the verified `x-user-id` and `x-user-role`. |

---

## 3. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STOREFRONT (Port 3011)                            │
│  - Sends fetch(url, { credentials: 'include' })                             │
│  - Receives Set-Cookie: commerce.accessToken; commerce.refreshToken         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (HTTP + Cookies)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          API GATEWAY (Port 3000)                            │
│  1. GatewayJwtGuard extracts token from Cookie or Bearer header             │
│  2. Verifies JWT signature (JWT_SECRET) and extracts 'sid' (Session ID)     │
│  3. Fast check Redis: EXISTS session:<sid> (<0.5ms)                         │
│     ├─► If missing/revoked: Rejects immediately with 401 Unauthorized       │
│     └─► If active: Injects 'x-user-id' and 'x-user-role' headers            │
│  4. Proxies request to downstream microservices                             │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
                       ▼                               ▼
       ┌───────────────────────────────┐     ┌────────────────────────────────┐
       │   orders-service, cart, etc.  │     │      users-service (:3008)     │
       │   Reads trusted 'x-user-id'   │     │  - Manages User & Session DB   │
       │   (Completely decoupled)      │     │  - Syncs Redis 'session:<sid>' │
       └───────────────────────────────┘     │  - Hashes tokens with SHA-256  │
                                             └────────────────┬───────────────┘
                                                              │
                                                              ▼
                                             ┌────────────────────────────────┐
                                             │           users_db             │
                                             │  - users (with status)         │
                                             │  - user_sessions (with hash)   │
                                             │  - password_resets             │
                                             └────────────────────────────────┘
```

---

## 4. Phased Execution Roadmap

### Phase 1: Database Schema & Entity Overhaul (`apps/users-service`) - [COMPLETED - Commit `eceafd9`]
* **Goal:** Clean, production-ready PostgreSQL tables for users, sessions, and password resets.
* **Tasks:**
  1. Reset `users_db` migrations.
  2. Create clean migration for `users` table:
     * `id` (UUID pk)
     * `email` (varchar, unique)
     * `name` (varchar)
     * `password_hash` (varchar)
     * `role` (enum: `customer`, `staff`, `admin`)
     * `status` (enum: `active`, `suspended`, `banned` — default: `active`)
     * `avatar_url` (varchar, nullable)
     * `is_email_verified` (boolean, default: false)
     * `last_login_at` (timestamp, nullable)
     * `created_at`, `updated_at`
  3. Create clean migration for `user_sessions` table:
     * `id` (UUID pk — becomes the `sid` in the JWT)
     * `user_id` (UUID fk ➔ `users.id` on delete CASCADE)
     * `token_hash` (varchar — SHA-256 hex of the refresh token)
     * `prev_token_hash` (varchar, nullable — grace window for concurrent rotation)
     * `user_agent` (varchar, nullable)
     * `ip_address` (varchar, nullable)
     * `expires_at` (timestamp)
     * `revoked_at` (timestamp, nullable)
     * `revocation_reason` (varchar, nullable)
     * `created_at`, `updated_at`
  4. Create migration for `password_resets` table:
     * `id` (UUID pk)
     * `user_id` (UUID fk ➔ `users.id` on delete CASCADE)
     * `token_hash` (varchar — SHA-256 of the one-time reset token)
     * `expires_at` (timestamp — 15 minute window)
     * `used_at` (timestamp, nullable)
     * `created_at`
  5. Implement TypeORM entity classes: [`UserEntity`](file:///d:/Year2/Microservices/Order‑Inventory‑Payment%20Microservices/ecommerce-microservices/apps/users-service/src/modules/users/user.entity.ts), `SessionEntity`, `PasswordResetEntity`.

---

### Phase 2: Core Session & Authentication Engine (`apps/users-service`) - [COMPLETED - Commit `3531a06`]
* **Goal:** Implement Angkoro's session lifecycle with SHA-256 token hashing and Redis synchronization.
* **Tasks:**
  1. Create `SessionService` in `apps/users-service`:
     * `createSession(userId, userAgent, ip)`: Inserts session row, hashes refresh token with SHA-256, and writes `session:<sid> = "active"` to Redis with TTL.
     * `rotateSession(sid, oldRefreshToken)`: Validates SHA-256 hash, issues new token pair, swaps `tokenHash`, and updates Redis TTL.
     * `revokeSession(sid, reason)`: Marks session `revoked_at = NOW()` in PostgreSQL and deletes `session:<sid>` from Redis.
     * `revokeAllUserSessions(userId, exceptSid)`: Revokes all other active sessions (remote logout).
     * `listUserSessions(userId)`: Returns all active devices for the authenticated user.
  2. Update `AuthService` in `apps/users-service`:
     * Register & Login generate a session row and embed `sid` in the access token:
       `{ sub: user.id, email: user.email, role: user.role, sid: session.id }`.
     * Check user status (`ACTIVE` vs `SUSPENDED` vs `BANNED`).
     * Set `httpOnly` secure cookies on outgoing response:
       * `commerce.accessToken` (`Max-Age: 3600`, `HttpOnly`, `SameSite: Lax`, `Path: /`)
       * `commerce.refreshToken` (`Max-Age: 604800`, `HttpOnly`, `SameSite: Lax`, `Path: /api/v1/auth`)
  3. Create session management endpoints in `AuthController`:
     * `GET /api/v1/auth/sessions` (list my devices)
     * `DELETE /api/v1/auth/sessions/:id` (log out specific device)
     * `DELETE /api/v1/auth/sessions` (log out all other devices)

---

### Phase 3: Password Reset Flow (`apps/users-service`) - [COMPLETED - Commit `5c7bf2b`]
* **Goal:** Cryptographically secure self-service password recovery.
* **Tasks:**
  1. Create `PasswordResetService`:
     * `requestReset(email)`: Generates a cryptographically random 32-byte hex token, hashes with SHA-256, saves to `password_resets`, and emits `user.password_reset_requested` event.
     * `verifyToken(token)`: Validates token hash, ensures `expires_at > NOW()` and `used_at IS NULL`.
     * `confirmReset(token, newPassword)`: Hashes new password with `bcrypt`, updates user record, marks reset token as used, and **revokes all active sessions** across all devices for security!
  2. Endpoints in `AuthController`:
     * `POST /api/v1/auth/password-reset/request`
     * `POST /api/v1/auth/password-reset/confirm`

---

### Phase 4: API Gateway Security Perimeter (`apps/api-gateway`) - [COMPLETED - Commit `7736fd4`]
* **Goal:** Verify tokens, enforce Redis live-session checks, and manage cross-origin cookies.
* **Tasks:**
  1. Configure CORS in `apps/api-gateway/src/main.ts`:
     ```typescript
     app.enableCors({
       origin: ['http://localhost:3011', process.env.STOREFRONT_URL].filter(Boolean),
       credentials: true,
     });
     ```
  2. Update `GatewayJwtGuard`:
     * Extract token from `request.cookies['commerce.accessToken']` or fallback to `Authorization: Bearer <token>`.
     * Decode JWT and verify signature with `JWT_SECRET`.
     * Read `payload.sid`:
       * Query Redis: `redis.get('session:' + payload.sid)`.
       * If absent or revoked: throw `UnauthorizedException('Session has been revoked or expired')`.
     * Pass verified `x-user-id` and `x-user-role` downstream to microservices.

---

### Phase 5: Next.js Storefront Cookie Integration (`storefront/`) - [COMPLETED - Commit `dde5d6c`]
* **Goal:** Transparent cookie-based authentication with seamless cart merging.
* **Tasks:**
  1. Update `storefront/lib/api.ts`:
     * Set `credentials: 'include'` on all `fetch` requests.
     * Ensure seamless cookie transmission across ports (:3011 -> :3000).
  2. Update `storefront/app/login/page.tsx`:
     * Simplify login handling: server sets cookies automatically.
     * Trigger `refreshCart()` after login to preserve guest-to-user cart merging.
     * Add "Forgot password?" navigation link.
  3. Create Session Management UI:
     * Account page (`/account`) showing active logged-in sessions (Device, IP, Login Time, Current badge).
     * Individual session revocation button.
     * "Log out of other devices" button (`DELETE /api/v1/auth/sessions`).
     * Self-service password reset page (`/password-reset`).

---

### Phase 6: Automated Testing & Verification Runbook - [COMPLETED]
* **Goal:** 100% test coverage and validation of all security layers.
* **Verification Checklist:**
  - [x] Migration runs cleanly on clean `users_db` (`CreateUsersTable`, `CreateSessionsTable`, `CreatePasswordResetsTable`).
  - [x] User registration & login sets `httpOnly` cookies (`commerce.accessToken`, `commerce.refreshToken`).
  - [x] Requesting protected endpoints passes through Gateway with verified `x-user-id`, `x-user-role`, and `x-session-id`.
  - [x] Logging in from a second browser creates a second session row in `user_sessions`.
  - [x] Calling `DELETE /api/v1/auth/sessions/:id` immediately revokes the session in PostgreSQL and deletes `session:<sid>` from Redis.
  - [x] Submitting a request with the revoked token returns `401 Unauthorized` instantly (<0.5ms via Redis).
  - [x] Password reset generates 32-byte secure token, updates password, and revokes all active sessions across all devices.
  - [x] Account status enforcement (`SUSPENDED` or `BANNED`) blocks login and rejects active requests with 403 Forbidden.

#### Verification Runbook Commands:
1. **Reset & Migrate `users_db`:**
   ```bash
   npm run migration:run --prefix apps/users-service
   ```
2. **Register & Receive Cookies:**
   ```bash
   curl -i -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"alice@example.com","name":"Alice","password":"Password123!"}'
   ```
   *Expected:* HTTP 201 with `Set-Cookie: commerce.accessToken=...; HttpOnly; SameSite=Lax; Path=/` and `Set-Cookie: commerce.refreshToken=...; HttpOnly; SameSite=Lax; Path=/`.
3. **List Active Devices & Sessions:**
   ```bash
   curl -i -X GET http://localhost:3000/api/v1/auth/sessions \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
   ```
4. **Remote Device Logout:**
   ```bash
   curl -i -X DELETE http://localhost:3000/api/v1/auth/sessions/<SESSION_ID> \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
   ```
   *Result:* Redis key `session:<SESSION_ID>` is purged immediately. Subsequent calls with that token return `401 Unauthorized`.
5. **Password Reset Flow:**
   ```bash
   curl -i -X POST http://localhost:3000/api/v1/auth/password-reset/request \
     -H "Content-Type: application/json" \
     -d '{"email":"alice@example.com"}'
   ```
   Confirm with token and new password:
   ```bash
   curl -i -X POST http://localhost:3000/api/v1/auth/password-reset/confirm \
     -H "Content-Type: application/json" \
     -d '{"token":"<RAW_RESET_TOKEN>","newPassword":"NewSecurePassword123!"}'
   ```
   *Result:* All active sessions for that user are terminated immediately across all devices!

## 5. Risk Assessment & Mitigation

| Risk | Mitigation |
| :--- | :--- |
| **CORS / Cookie Blocking** | Gateway explicitly declares `origin: ['http://localhost:3011']` and `credentials: true`. Cookies use `SameSite: 'lax'`, `Secure: false` in dev environment. |
| **Redis Downtime** | If Redis restarts, `users-service` repopulates the Redis key upon next token refresh, or Redis persistence (AOF/RDB) preserves session keys. |
| **Microservice Regression** | Downstream microservices only consume `x-user-id` and `x-user-role` headers from the gateway, meaning `orders-service`, `catalog-service`, and `payments-service` require zero code modifications. |
