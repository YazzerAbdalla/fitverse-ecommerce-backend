# Implementation Plan: Payment Simulation (Demo)

**Branch**: `018-payment-simulation` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-payment-simulation/spec.md` (Phase 19 demo, clarified 2026-10-07: Q1 owner-only writes, Q2 payment blocks expiry, Q3 reuse checkout 10/h, Q4 fixed decline enum, Q5 status-only list filter)

## Summary

Add a minimal in-repo `payment` module (no Stripe) that makes checkout → payment → completion clickable: `POST /payments/intent {orderId}` creates a 1:1 `PENDING` payment copying `Order.total`, `POST /payments/:id/confirm {success|declined}` atomically drives `Payment + Order + Reservation + Inventory` via the existing completion/cancellation paths, `POST /payments/:id/cancel` handles pre-confirm abandon, plus owner-scoped reads. All writes are single-transaction with `FOR UPDATE Payment → Order → Reservation → sorted Inventories` lock order; terminal re-confirm is idempotent 200 with zero delta.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js (NestJS 11 modular monolith)
**Primary Dependencies**: `@nestjs/common`, `@nestjs/typeorm`, `typeorm` ^1.1, `class-validator`/`class-transformer` (global `ValidationPipe` whitelist + forbidNonWhitelisted + transform), `@nestjs/jwt` + `@Auth()`/`JwtGuard`/`RolesGuard`, existing `RateLimitGuard` (shared via `AuthModule`)
**Storage**: PostgreSQL 17 via TypeORM (authoritative for `Payment` + `Order` + `Reservation` + `Inventory`); Redis 8 via `CACHE_MANAGER` for rate-limit counters + idempotent-skip counters only (never authoritative); no RabbitMQ publish from payment itself (order completed/cancelled rows flow through existing outbox paths)
**Testing**: Jest (`*.spec.ts` unit with mocked repos/services, real-PostgreSQL integration for tx/lock/constraints, `Promise.all` single-winner concurrency, supertest E2E for checkout→intent→confirm flows)
**Target Platform**: Linux server / Docker Compose (postgres, redis, rabbitmq), single NestJS process on `PORT` 3000
**Project Type**: Backend web-service (REST for payment; GraphQL untouched)
**Performance Goals**: Demo scope — intent/confirm p95 < 500ms local (excluding lock wait); concurrent confirms on one payment collapse to one mutation; list reads paginated (default 20, max 100)
**Constraints**: Single-transaction confirm/cancel (no network I/O inside tx); lock order fixed `Payment → Order → Reservation → sorted Inventories`; amount server-copied (never client-supplied); currency fixed `usd`; `provider='simulation'`; owner-only writes (Q1); terminal re-confirm 200 zero-delta; `CHECK amount >= 0`, `@Unique(orderId)`; global `AllExceptionsFilter` error shape
**Scale/Scope**: Demo — hundreds of payments, one payment per order, no partial capture, no refunds post-completion, no Stripe (deferred to §19.10 post-demo)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] I. PostgreSQL source of truth — `Payment` is a PG row; Redis holds only throttle/skip counters; no cache value feeds availability or ownership decisions.
- [x] II. Modular monolith — new `PaymentModule` under `src/modules/payment/`; collaborates via exported `OrderCompletionService`/`OrderCancellationService`/`OrderService` + `ReservationService` + `InventoryService`; no cross-module `@InjectRepository`.
- [x] III. Explicit lifecycles — `Payment PENDING → SUCCEEDED|FAILED|CANCELLED` only, terminal idempotent; `Order`/`Reservation` effects reuse `order-transitions.ts` + ADR-0010/0014 paths (success: `stock-=qty reserved-=qty`; decline/cancel: `reserved-=qty` only).
- [x] IV. DB-level concurrency — `FOR UPDATE` in fixed order, deterministic sorted inventory locks, short tx; `Promise.all` single-winner proof required.
- [x] V. Thin controllers — `PaymentController` parses DTO + `@Auth()` + `@CurrentUser()`, delegates to `PaymentService` (tx owner); no `DataSource`/repo in controller.
- [x] VI. Spec-driven — spec + 5 clarifications recorded; no silent assumptions; Stripe explicitly deferred.
- [x] VII. DB-backed tests — real-PG integration + concurrency + E2E (success + decline) mandatory; Redis/RMQ mocked where infra.
- [x] VIII. No invented APIs — routes/fields exactly per spec FR-001…FR-012 and `docs/plan.md §19.4` as narrowed by Q1/Q4/Q5 (no orderId filter on list, fixed decline enum, owner-only writes).
- [x] IX. Docs as work — ADR-payment-simulation + `manual-e2e` § update + Swagger annotations planned.

Post-design re-check: no new gate failures introduced (see Complexity Tracking — none).

## Project Structure

### Documentation (this feature)

```text
specs/018-payment-simulation/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── payment-api.md   # REST contract for intent/confirm/cancel/reads
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── payment/                        # NEW (demo scope)
│   │   ├── payment.module.ts           # forFeature([Payment]) + imports Order/Reservation/Inventory/Users via services
│   │   ├── payment.service.ts          # createIntent/confirm/cancel/get/list (owns tx boundaries)
│   │   ├── payment.controller.ts       # thin REST, @Auth() + RateLimitGuard + ValidationPipe + Swagger
│   │   ├── entities/payment.entity.ts  # Payment + PaymentStatus enum
│   │   ├── dto/create-payment-intent.dto.ts
│   │   ├── dto/confirm-payment.dto.ts
│   │   └── payment.service.spec.ts (+ integration/e2e alongside)
│   ├── order/                          # REUSED (completion/cancellation cores, transitions, assertOwner)
│   ├── reservation/                    # REUSED (expiry skip for pending-payment orders per Q2)
│   ├── inventory/                      # REUSED (locked rows only, no new logic)
│   └── auth/                           # REUSED (JwtGuard/RolesGuard/RateLimitGuard via AuthModule)
├── migration/                          # NEW migration CreatePayment (never edit committed)
test/                                  # E2E additions (checkout→intent→confirm success + decline)

tests/
├── unit/         # service + DTO validation (mocked repos/services)
├── integration/  # real-PG tx/lock/constraint/concurrency proofs
└── e2e/          # supertest happy-path + decline path
```

**Structure Decision**: Single NestJS modular monolith preserved. Payment is a new leaf module that owns only `Payment` persistence and orchestrates the existing order/reservation/inventory transaction cores — no new shared framework, no generic base classes (per MF-1).

## Complexity Tracking

> No constitution violations requiring justification. No new abstraction beyond the one mandated `PaymentService` + `Payment` entity (spec FR-001…FR-012).
