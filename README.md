# Mini E-Commerce — High-Concurrency Modular Monolith

> This is **not a CRUD app**. It's a concurrency-safe, event-driven commerce core: pessimistic inventory locking with deterministic lock ordering, 15-min TTL reservation lifecycle, transactional outbox + at-least-once delivery, idempotent retries, rotating refresh-token auth with theft detection, and distributed rate-limiting — all proven by real-PostgreSQL `Promise.all` single-winner tests.

NestJS 11 + PostgreSQL 17 (authoritative) + Redis 8 (cache only) + RabbitMQ 4 / BullMQ (async only) + GraphQL (catalog) / REST (commerce) + Next.js storefront contract (integration phase).

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Core Engineering Challenges Solved](#2-core-engineering-challenges-solved)
3. [Tech Stack Deep-Dive](#3-tech-stack-deep-dive)
4. [Database Schema & Concurrency Mechanisms](#4-database-schema--concurrency-mechanisms)
5. [API Surface](#5-api-surface)
6. [Frontend Integration (Current Phase)](#6-frontend-integration-current-phase)
7. [Quickstart](#7-quickstart)
8. [Testing & Concurrency Proofs](#8-testing--concurrency-proofs)
9. [Configuration](#9-configuration)
10. [Decisions (ADRs)](#10-decisions-adrs)
11. [Roadmap](#11-roadmap)

## 1. System Architecture Overview

**Style: modular monolith, clean boundaries.** One NestJS process, one PostgreSQL DB. Redis/RabbitMQ/BullMQ are infrastructure — never sources of truth.

```text
Client (REST + GraphQL + WS)
        │
        ▼
NestJS (main.ts: ValidationPipe whitelist/forbid/transform,
        AllExceptionsFilter REST {statusCode,message,timestamp} / GraphQL extensions.code,
        Swagger /api, CORS allow-list + credentials:true, RMQ microservice noAck:false prefetch:10)
        │
        ▼
Modules (src/modules/*) — Controller thin (parse + @Auth/@CurrentUser) → Use-case Service (owns tx)
  → Intent-based Stores (tx-scoped EntityManager in, never commit) → Entity → Ports → Adapters
        │
        ▼
PostgreSQL 17 ◄── authoritative: users/products/cart/inventory/reservations/orders/tokens/outbox
Redis 8       ◄── cache/dedup/rate-limit/poison/cooldown ONLY (fail-open everywhere)
RabbitMQ 4 / BullMQ ◄── async AFTER commit (never inside tx)
```

**Module map:**

| Module | API | Owns |
|---|---|---|
| `auth` / `users` | REST | JWT 15m + opaque refresh 7d rotation, `tokenVersion` nuke, Google OAuth, reset/verify; `UsersService` sole User writer |
| `products` | GraphQL (Apollo code-first) | Catalog + cache-aside; no `stock` field |
| `inventory` | REST (reads any-role, writes `Admin`) | Sole mutator of `stock`/`reservedAmount`; `available` derived |
| `reservation` | REST | `RESERVED→COMPLETED\|EXPIRED\|CANCELLED`, BullMQ expiration worker 30s / 60s SLA |
| `order` / `payment` | REST | `PENDING→COMPLETED\|CANCELLED\|FAILED` checkout/completion/cancel; `Payment` 1:1 `Order` simulation (`intent→confirm`) |
| `outbox` / `notifications` | internal + `Admin` ops | Transactional outbox + dual-channel (`SYSTEM` WS + `EMAIL`) Strategy+Factory dispatch |
| `dashboard` | REST `Admin` | Read-only join aggregator (owns no tables) |

**Rules enforced:** cross-module via exported services only (no cross `@InjectRepository`); controllers tx-free (services own `dataSource.transaction`); no `client.emit`/`Queue`/`cache.store.client` inside business logic; strict `no-any`, JSDoc on every public class/method.

## 2. Core Engineering Challenges Solved

### a) No overselling under concurrency

`POST /order/checkout {}` runs one tx: load cart → snapshot `Product.price` → map `productId→inventoryId` → `SELECT … FOR UPDATE` in **lexicographically sorted order** → check `available = stock - reservedAmount >= qty` → `reservedAmount += qty` → create `Order PENDING (total=Σ qty×price)` + `OrderItems` (historical snapshot) + `Reservation RESERVED (expiresAt=now+15m)` → clear cart → commit. Deadlock-proof by construction; last-unit race = exactly one `201`, other `409`. Proven by real-PG `Promise.all` suites (checkout-vs-checkout, complete-vs-complete, complete-vs-expire).

Lifecycle keeps the invariant: `COMPLETED: stock-=qty, reserved-=qty`; `CANCELLED/EXPIRED: reserved-=qty` only. Same-transition replay → `200` zero-delta **before** inventory locks; cross-transition → `409`; Postgres `23514/CHK_*` → `409`.

### b) Reliable events without distributed transactions (Transactional Outbox)

Business row + `outbox_event` (`PENDING`) inserted with the **same `EntityManager`** — invariant `commit → PENDING row`. Publisher claims via `FOR UPDATE SKIP LOCKED LIMIT 100` with `processingToken` lease (30s reclaim, late-writer guard `WHERE token=:token`), publishes **persisted payload byte-equal** (`payload.eventId == id`, `version:1`, `correlationId` from `X-Request-Id`), exponential backoff `1s·2ⁿ⁻¹` cap 60s, max 5 → `FAILED` retained 30d + `PATCH /admin/outbox/:id/requeue`. States extended: `PENDING→PROCESSING→SENT_TO_MQ→CONSUMED→DELIVERED→FAILED` + per-channel `NotificationDelivery` rows. RMQ never inside tx.

### c) Idempotent, self-healing workers

Redis `SET NX notification:processed:<eventId> EX 24h` + per-user `notification:send:<campaign>:<user> 24h` + PG `@Unique(eventId,channel)` backstop; `INCR idempotency:duplicate:skipped:*` observability; poison `3→quarantine 24h` (transients only — `200/404` never counted); expiration tick singleton via `SET expiration:tick:lock NX EX ttl+5` + BullMQ `concurrency:1` repeat 30s.

### d) Auth that survives theft + scale

Short JWT (15m, `sub/email/role/tokenVersion`) + opaque refresh (`randomBytes(32)→sha256`, 7d, partial unique `WHERE revokedAt IS NULL`, cap-5 LRU). `refresh` = `FOR UPDATE` single-use rotation; reuse = **theft path**: `401` + bulk revoke-all + warn (hash-prefix-6 only, raw never logged). `tokenVersion++` on `reset-password`/`logout-all` kills all sessions. Transport: `Authorization: Bearer` (access) + `HttpOnly; SameSite=Strict; Path=/auth` cookie **or** body (body wins). `SafeUser` allow-list DTO (no rest-spread leaks), anti-enumeration `200`s, Google `state:true` + verified-email auto-link.

### e) Redis correctness discipline

Cache-aside catalog (`products:list:v{n}:{page}:{limit}` 60s + `product:{id}` 300s, fail-open, deterministic `ORDER BY created_at,id`, selective `del` + version-bump — **never `clear()`** on shared store). Rate limits are per-route fixed-window `rl:{METHOD} {PATH}:{dim}:{value}` (auth 3-20/h, checkout/complete/payment 10/h/user, cart 60/h/user, product-mutation 30/h/admin), **outermost guard** so `429` never holds `FOR UPDATE`, fail-open with `Retry-After` + `X-RateLimit-*`. TTL reservations live in **Postgres `expiresAt`** (DB truth), Redis holds only tick/poison/dedup/cooldown.

## 3. Tech Stack Deep-Dive

| Layer | Choice | Why it matters here |
|---|---|---|
| Backend | **NestJS 11 + TypeScript strict** | Modular monolith, DI, Passport/JWT, interceptors/filters/pipes globally |
| API | **REST (auth/cart/order/payment/notify) + GraphQL Apollo code-first (products)** | Catalog flexibility vs commerce Swagger contracts; shared validation/error pipeline |
| DB/ORM | **PostgreSQL 17 + TypeORM** | `FOR UPDATE`/`SKIP LOCKED`, CHECK/UNIQUE/partial/composite indexes, generated `subtotal STORED`, real migrations (`synchronize:false`) |
| Cache/limiter | **Redis 8 via `@nestjs/cache-manager` + `@keyv/redis` (ioredis)** | Catalog cache, `rl:*`, `expiration:tick:lock`, dedup/cooldown — ephemeral only |
| Messaging/jobs | **RabbitMQ 4 (`NOTIFICATION_SERVICE`) + BullMQ 6** | Outbox → exchange → verification queue (durable, manual ACK); BullMQ for expiration repeat + bulk fan-out only |
| Realtime | **Socket.IO `notifications` namespace** | Ephemeral `notification:new` badge hint (`user:<sub>` rooms); history `GET /notifications` is truth (known `tokenVersion` gap documented) |
| Auth/crypto | **Passport-local/jwt/google, bcrypt(10), `crypto.randomBytes/randomInt/sha256`** | No raw tokens stored/logged |
| Email | **Strategy+Factory (`SYSTEM`/`EMAIL`, `EMAIL_PROVIDER=noop\|smtp\|resend`)** | Runtime prefs resolution (`verify/reset` always both; sales needs `marketingOptIn&&emailOptIn&&emailVerified`) |
| Frontend (contract) | **Next.js App Router or Vite SPA + Apollo Client + TanStack Query + RHF/Zod + Tailwind + socket.io-client** | Spec'd in `docs/frontend-handoff/`; single-flight refresh coordinator, `credentials:include`, `x-request-id` tracing |
| Infra | **Docker Compose (postgres/redis/rabbitmq), Jest + supertest, Swagger `/api`** | One-command boot; unit + real-PG integration + E2E |

## 4. Database Schema & Concurrency Mechanisms

**Invariants (DB-enforced, not just code):** `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`, `quantity>0`, `price>=0`, `total>=0`, one `Inventory` per `Product` (`@Unique(productId)`), one `Payment` per `Order`, one live verify token per `User` (columns, history dropped per ADR-0013).

**Key tables:** `User (tokenVersion, emailVerified, prefs, partial uniques on phone/google)` · `Product (price, Unique name/slug)` · `Inventory (stock, reservedAmount, available getter)` · `Reservation (status enum, expiresAt) + ReservationItem (Unique reservation+inventory)` · `Order (PENDING|COMPLETED|CANCELLED|FAILED) + OrderItem (unit_price snapshot, subtotal GENERATED ALWAYS AS qty*price STORED)` · `Payment (PENDING|SUCCEEDED|FAILED|CANCELLED, amount=Order.total copy)` · `RefreshToken/PasswordResetToken (sha256, FOR UPDATE races)` · `OutboxEvent (status/attempts/nextRetryAt/processingToken)` · `Notification/Delivery/Log`.

**Concurrency index:** composite `(status,nextRetryAt,createdAt)` (publisher `EXPLAIN`-proven), `(status,expiresAt)` (expiry scan), `(userId,createdAt)`, FK/lookup indexes; lock order `Payment→Order→Reservation→sorted Inventories` (payment) / `Reservation→sorted Inventories` (lifecycle) / `Order→Reservation→sorted Inventories` (completion).

## 5. API Surface

- Auth: `POST /auth/register|login|refresh|logout|logout-all|forgot-password|validate-reset-token|reset-password|verify-email (GET+POST)|resend-verification`, `GET /auth/google|/callback|/link`, `GET /users/me`, `PATCH /users/me/preferences`
- Catalog: `query products(page,limit)`, `query product(id)` (public, cached)
- Cart: `GET /cart`, `POST /cart`, `PATCH /cart/increase|decrease`, `DELETE /cart/:id|/cart` (`User`-only)
- Order: `POST /order/checkout` (+ alias `POST /order`), `POST|PATCH /order/:id/complete` (admin fallback), `POST /order/:id/cancel`, `GET /order|/order/:id`
- Payment (simulation): `POST /payments/intent`, `POST /payments/:id/confirm {success|declined(card_declined|insufficient_funds|expired_card)}`, `POST /payments/:id/cancel`, `GET /payments*`
- Inventory/reservation reads: `GET /inventory/:id|/availability`, `GET /reservations*` (shopper writes deterministic `403` — checkout-only)
- Notifications: `GET /notifications|/unread-count`, `PATCH /notifications/:id/read|/read-all`; Admin: `POST /admin/notifications/sales|/test-email`, `GET|PATCH /admin/outbox`, `GET|POST|PATCH /admin/products|/stock`

## 6. Frontend Integration (Current Phase)

Handoff package (`docs/frontend-handoff/`, 2026-10-10) is the build spec: `api-contract.md` (every `API-REST-*`/`API-GQL-*` with wire 200/201/202/400/401/403/404/409/429 shapes), `schema.graphql` (verbatim backend copy), `authentication-and-session.md` (refresh-once→retry-once, theft → `/login?expired=1`), `frontend-data-models.md`, `user-flows.md` (`FLOW-AUTH/CAT/CART/ORD/NOTIF`), `frontend-architecture.md` (fetch wrapper, Apollo, query keys, cache rules: products `staleTime 30s`, availability `0`, no optimistic checkout). No secrets in browser; SafeUser only.

## 7. Quickstart

```bash
docker-compose up -d            # postgres 5432, redis 6379, rabbitmq 5672
cp .env.example .env            # never commit .env (JWT/GOOGLE/SMTP secrets)
npm ci && npm run build && npm run start:dev
curl http://localhost:3000/api  # Swagger
# Happy path: register → login → POST /cart → POST /order/checkout {} → POST /payments/intent → POST /payments/:id/confirm {success} → GET /order/:id COMPLETED
```

## 8. Testing & Concurrency Proofs

`npm run lint && npm run build && npm run test -- --runInBand && npm run test:e2e` — unit (mocked ports) + **real-PG integration** (transactions/locks/constraints never mocked) + E2E (`register→login→cart→checkout→intent→confirm`). Every locking/idempotency change ships a `Promise.all` single-winner test + `EXPLAIN` index proof. Full manual matrix: `docs/manual-e2e-test-flow.md`.

## 9. Configuration

All via `ConfigService` (never hardcoded): `POSTGRES_*, REDIS_URL, RABBITMQ_URL, JWT_SECRET/EXPIRES_IN, REFRESH_*, RESET/OTP_*, GOOGLE_*, EMAIL_*/SMTP_*, FRONTEND_URL/CORS_ORIGINS, OUTBOX_*, EXPIRATION_*, *_RL_MAX/WINDOW_MS, PAYMENT_CURRENCY, DASHBOARD_*`. Numeric clamps warn (`raw→applied`); absurd values fail boot; prod `WS_AUTH=false` fails closed.

## 10. Decisions (ADRs)

`docs/decisions/` — 0001 monolith, 0002 PG+TypeORM, 0003 Redis-cache-only, 0004 RMQ-async, 0005 JWT, 0006 GraphQL-products, 0007-0010 inventory/reservation/lifecycle, 0011 auth-upgrades/idempotency, 0012 RP-AUTH orchestrator, 0013 verify-fold, 0014 cancel-before-sale, 0015 admin-stock, 0016 cache-constraints, 006 expiry, async-events, checkout-only, email-service, payment-simulation, refresh-token.

## 11. Roadmap

DONE: inventory → reservation → tx-safe → lifecycle → expiry → checkout → completion → cancel-before-sale → cache/rate-limit → outbox/idempotency → refresh → email/notify → payment-sim → admin-stock. NEXT: storefront build per `frontend-handoff/implementation-roadmap.md` (Phase 0 contract probe → auth coordinator → catalog/cart → checkout/orders → notifications → hardening). DEFERRED post-demo: full Stripe, refunds (`COMPLETED→CANCELLED`), server search/images, guest cart, 5-role RBAC + 5-metric dashboard.
