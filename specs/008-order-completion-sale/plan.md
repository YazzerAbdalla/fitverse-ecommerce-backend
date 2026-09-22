# Implementation Plan: Order Completion / Sale (Phase 7)

**Branch**: `008-order-completion-sale` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-order-completion-sale/spec.md` (Phase 7 — `docs/plan.md` §§7.1-7.2 + 8 clarifications Session 2026-09-22: Q1 POST owner-or-Admin, Q2 idempotent COMPLETED→COMPLETED 200, Q3 no Payment entity, Q4 single-winner vs expiry via FOR UPDATE, Q5 no available re-check rely on DB CHECK, Q6 ReservationItem.inventoryId as source, Q7 post-commit events deferred to Phase 11, Q8 uses OrderStatus PENDING|COMPLETED|CANCELLED|FAILED)

## Summary

Implement the missing Phase 7 sale transition that **permanently decreases stock** while releasing its reservation. Today `POST /order/checkout` creates `Order PENDING` + `Reservation RESERVED` + `reservedAmount+=qty` atomically, but `stock` is never decremented. `PATCH /reservations/:id/complete` exists transactionally (`stock-=qty reserved-=qty`) but is restricted to `Admin` (`User→403 Reservation transitions via Order lifecycle only` per Phase 6 refactor) — there is **no user-facing Order completion path**.

Phase 7 V1 will: (a) add **`validateOrderTransition(from,to)`** (mirrors `ReservationService.validateTransition`/`ALLOWED_TRANSITIONS`) and adopt `PENDING→COMPLETED` as the only user-triggered transition (plus idempotent `COMPLETED→COMPLETED 200`, defined-but-deferred `PENDING→FAILED` guard only); (b) implement **`OrderCompletionService.complete(manager,userId,orderId)`** (or `OrderService.complete`) inside `DataSource.transaction` that locks `Order FOR UPDATE` → `assertOwner` → `validateOrderTransition` → locks `Reservation WHERE orderId FOR UPDATE` → `validateTransition RESERVED→COMPLETED` → locks sorted `Inventories FOR UPDATE` → `stock-=qty reserved-=qty` per `ReservationItem` → updates `Order COMPLETED` + `Reservation COMPLETED` atomically, mapping DB `CHECK 23514` to `409`; (c) expose **`POST /order/:id/complete`** (alias `PATCH` allowed) as thin controller (`@Auth()` owner-or-Admin, empty `CompleteOrderDto` with `forbidNonWhitelisted`, response includes `status COMPLETED` + `reservationId`); keep `PATCH /reservations/:id/complete` as `Admin`-only internal path (no change). No `Payment` entity, no new migration, no Redis/RabbitMQ I/O inside transaction, no new columns — only a new service/method + DTO + controller route + tests. Exit criterion `A completed sale permanently decreases stock while releasing its reservation` is verified by real-PG integration concurrency tests (`complete vs complete` idempotent single stock decrement, `complete vs expire` single winner).

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/common` 11.1.28, `@nestjs/typeorm` 11 + `typeorm` 1.1, `pg` 8.22, `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`, existing `CacheModule` (`@keyv/redis` + `ioredis` 5) and `@nestjs/microservices` (kept but not used inside completion transaction). No new dependency required (BullMQ only for Phase 5 expiration worker, not completion).  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; **no new migration** — reuses `Order` (`PENDING|COMPLETED|CANCELLED|FAILED` enum, indexes `userId`/`status`, `CHECK total>=0`), `OrderItem` (`@Unique orderId+productId`, `CHECK quantity>0`, `CHECK unit_price>=0`), `Inventory` (`CHECK stock>=0`, `CHECK reservedAmount>=0`, `CHECK reservedAmount<=stock`, `@Unique productId`), `Reservation` (`composite status+expiresAt` index, `FK orderId SET NULL`). Redis 8 and RabbitMQ 4 remain infra but are **not** touched by completion transaction per constitution I.  
**Testing**: Jest unit (mocked `EntityManager`, `ReservationService.validateTransition`, DTO empty-body) + integration/concurrency against **real PostgreSQL** (`--runInBand`, `FOR UPDATE` single-winner, `EXPLAIN` row-level lock), `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`.  
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phases 5-6, no frontend.  
**Project Type**: Modular monolithic backend — REST `order` (`POST /order/:id/complete` new, `GET /order`, `GET /order/:id`) + refactored `reservation` (no user `POST`); GraphQL `products` unchanged.  
**Performance Goals**: Completion holds row locks <100ms under no contention; `FOR UPDATE` on `Order` PK + `Reservation` by `orderId` (indexed) + `Inventory` via `id In(sortedIds)` uses PK indexes, no table lock; deterministic `inventoryId` sort prevents deadlocks `[A,B]` vs `[B,A]`; no availability pre-check — DB `CHECK` is backstop per Phase 4 Q2. Worker `complete vs expire` race stays single-winner via same ordering (Order first, then Reservation, then Inventories).  
**Constraints**: `synchronize:false`; PostgreSQL is authoritative truth (constitution I); cross-module calls via exported services only (`OrderModule` imports `ReservationModule` + `InventoryModule` already, no new module); global `ValidationPipe` (`whitelist`+`forbidNonWhitelisted`+`transform`) and `AllExceptionsFilter` remain; `Order.total`/`OrderItem` historical `unit_price` never recalculated on completion; `Cart` never mutates inventory.  
**Scale/Scope**: Touches `src/modules/order/` (new `order-completion.service.ts` or extension of `order.service.ts` + `dto/complete-order.dto.ts` + `order.controller.ts` route + `order-status` transition guard), touches `src/modules/reservation/` only to reuse `validateTransition`/`ReservationStatus` (no controller change); 0 new PG tables, 0 new migrations, 0 new queues. 8 SCs map to 8+ integration/concurrency tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | Completion availability is **not rechecked** — it relies on `stock-=qty` inside `SELECT ... FOR UPDATE` on `Order`+`Reservation`+`Inventory` via `EntityManager` inside `dataSource.transaction`; no Redis/RabbitMQ I/O inside tx. Post-commit `order.completed` event is deferred to Phase 11 (Q7 defer). No cache drives sale decision. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Completion stays inside single Nest process as `OrderCompletionService` consuming `ReservationService.validateTransition` + `Inventory` rows via `manager`; no new service/process, single `OrderModule` owns the transaction. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No new states; only `PENDING→COMPLETED` (Order) + `RESERVED→COMPLETED` (Reservation) with `stock-=qty reserved-=qty` per §III. Idempotent `COMPLETED→COMPLETED 200` mirrors Reservation Q4. No `available` mutable column, `available` stays `stock - reservedAmount`. |
| **IV. Concurrency safety at DB level (no overselling/double-sale)** | ✅ PASS | Core deliverable: per-transaction `FOR UPDATE` on `Order` first, then `Reservation` by `orderId`, then sorted `Inventories`; deterministic ordering prevents deadlocks; single-winner `complete vs complete` (only one `stock` decrement) + `complete vs expire` (one does `stock-=qty`, other `reserved-=qty`) proven via real-PG concurrency test. DB `CHECK stock>=0` backstop maps `23514` → `409`. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `OrderCompletionService` owns orchestration, reuses `ReservationService.validateTransition` (no duplicate `ALLOWED_TRANSITIONS` logic copy) and `Inventory` via `EntityManager`; controller remains thin; no cross-module `@InjectRepository` of another module's entity. `ReservationModule` still `exports:[ReservationService]` for worker. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 8 clarifications Session 2026-09-22 (Q1 POST owner-or-Admin, Q2 idempotent, Q3 no Payment, Q4 race, Q5 no available check, Q6 ReservationItem source, Q7 events deferred, Q8 FAILED guard) done before plan; no future phases (cancellation Phase 8) implemented; checkout-only directive preserved. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Real-PG integration required for `PENDING→COMPLETED` stock decrement, `FOR UPDATE` single-winner `complete vs complete` idempotent, `complete vs expire` single-winner, ownership `403`, invalid `CANCELLED/FAILED 409`, missing Reservation `404`, and `EXPLAIN` row-level lock; unit mocks only for guards/DTO/`validateOrderTransition`. Research D5 maps to `npm run test -- --runInBand`. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | Only `POST /order/:id/complete` (empty `{}`, owner-or-Admin) is the new REST contract; aliases `PATCH` allowed but not invented. No `Payment` entity, no Stripe webhook, no new reservation state/column, no `available` stored column. Historical `unit_price`/`total` never re-derived. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/008-order-completion-sale/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` Phase 7 exit criterion traceable; ADR updated if needed (no new ADR required — completion reuses checkout-only ADR). |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (decisions D1-D6 preserve same invariants, no new state/cache).

## Project Structure

### Documentation (this feature)

```text
specs/008-order-completion-sale/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D6, risks, no-payment rationale, lock ordering, idempotency
├── data-model.md        # Phase 1 output — Order lifecycle COMPLETED, Reservation COMPLETED, Inventory sale arithmetic, CompleteOrderTransaction model
├── quickstart.md        # Phase 1 output — setup + manual complete + concurrent/idempotent verification
├── contracts/
│   └── order-complete.md        # Phase 1 output — POST /order/:id/complete (owner-or-Admin, empty DTO, 200/403/404/409)
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass after 8 clarifies)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── order/
│   │   ├── entities/
│   │   │   ├── order.entity.ts              # unchanged (status PENDING|COMPLETED|CANCELLED|FAILED, OneToMany OrderItem, FK userId, indexes)
│   │   │   ├── order-items.entity.ts        # unchanged (quantity>0, unit_price>=0, productId FK RESTRICT, Unique(orderId,productId))
│   │   │   └── order-status.enum.ts         # unchanged (PENDING|COMPLETED|CANCELLED|FAILED) — add validate helper if not in service
│   │   ├── dto/
│   │   │   ├── checkout.dto.ts              # unchanged (cart-only empty DTO)
│   │   │   └── complete-order.dto.ts        # NEW — empty DTO (no fields, forbidNonWhitelisted, any field → 400)
│   │   ├── order.service.ts                 # MODIFY — add validateOrderTransition(from,to) + assertOwner if not exported; keep findAll/findOne
│   │   ├── order-completion.service.ts      # NEW — complete(manager,userId,orderId): DataSource.transaction orchestration (lock Order→Reservation→sorted Inventories → stock/reserved mutation → save)
│   │   ├── order.controller.ts              # MODIFY — add POST /order/:id/complete (@Auth() owner-or-Admin, calls dataSource.transaction→OrderCompletionService), alias PATCH optional; keep POST /order/checkout + GET /order + GET /order/:id
│   │   └── order.module.ts                  # MODIFY — provide/export OrderCompletionService, imports ReservationModule (validateTransition), InventoryModule (entity), ensure Order/OrderItem TypeOrmModule
│   ├── reservation/
│   │   ├── reservation.service.ts           # unchanged (validateTransition, ReservationTransitionBuilder, complete/cancel/expire Admin-only) — reused for Reservation COMPLETED validation
│   │   ├── reservation.controller.ts        # unchanged (PATCH /reservations/:id/complete stays Admin-only; Order path is user-facing)
│   │   ├── entities/
│   │   │   ├── reservation.entity.ts        # unchanged (status, expiresAt, composite index, orderId FK)
│   │   │   ├── reservation-item.entity.ts   # unchanged (quantity>0, Unique reservationId+inventoryId)
│   │   │   └── reservation-status.enum.ts   # unchanged
│   │   └── reservation.module.ts            # unchanged (exports ReservationService)
│   ├── inventory/
│   │   └── entities/inventory.entity.ts     # unchanged (stock/reservedAmount/available, CHECKs)
│   ├── cart/
│   │   └── cart.service.ts                  # unchanged (clearCartForCheckout already exists; not used by completion)
│   └── app.module.ts                        # MODIFY if needed — ensure OrderModule wiring correct
├── migration/                               # no new migration in Phase 7 (reuse existing Order/Inventory CHECKs)
├── data-source.ts                           # unchanged (synchronize:false)
└── test/app.e2e-spec.ts                     # optional: extend e2e register→add→checkout→complete→GET order→price mutation check

```

**Structure Decision**: Single project (Option 1) — augment existing `src/modules/order/` with `OrderCompletionService` + `CompleteOrderDto` + `POST /order/:id/complete` route, reusing `ReservationService.validateTransition` and `Inventory` via `EntityManager`. No new top-level module, no PG migration, no queue — consistent with `AGENTS.md` Transactions rule “caller owns commit/rollback” and Phase 6's checkout-only pattern.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. No new API/state/cache invented.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 8 business clarifications in spec Session 2026-09-22). Key decisions: D1 idempotent COMPLETED→COMPLETED vs 409, D2 lock ordering Order→Reservation→sorted Inventories, D3 no available pre-check rely on DB CHECK, D4 single-winner complete vs complete / complete vs expire, D5 historical price/total immutability, D6 no Payment entity & FAILED guard-only, D7 payload & alias. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): Order `PENDING→COMPLETED` idempotent, Reservation `RESERVED→COMPLETED`, Inventory `stock-=qty reserved-=qty` (available unchanged), `CompleteOrderTransaction` model `load Order FOR UPDATE → assertOwner → validateOrderTransition → lock Reservation FOR UPDATE → validateTransition → lock sorted Inventories FOR UPDATE → mutate → save`.
- **Contracts** → [contracts/order-complete.md](./contracts/order-complete.md): `POST /order/:id/complete` empty DTO (`200`/`403`/`404`/`409`), `PATCH` alias optional, `GET /order`/`GET /order/:id` owner-scoped, `GET /reservations/:id` COMPLETED.
- **Quickstart** → [quickstart.md](./quickstart.md): Env no new keys, `npm run build/lint`, `docker-compose up -d`, manual curl: `POST /order/checkout` → `POST /order/:id/complete` as owner → `200 COMPLETED` + `stock` decrement, concurrent `Promise.all` single-winner idempotent, `GET /order/:id` price isolation, `npm run test -- --runInBand`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/008-order-completion-sale/plan.md`).

### Agent context update

`AGENTS.md` marker updated via `setup-plan.ps1` + manual correction to this plan (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Completion reuses checkout-only reservation refactor and improves constitution IV (single sale producer is OrderCompletionService, no duplicate stock logic).

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 7 into ordered tasks (e.g.: 1) failing integration test `POST /order/:id/complete` owner `PENDING→COMPLETED` stock decrement; 2) failing concurrent `complete vs complete` idempotent single-winner + `complete vs expire` single-winner; 3) implement `validateOrderTransition` + `OrderCompletionService.complete(manager,userId,orderId)` with sorted `FOR UPDATE` + `CHK 23514→409`; 4) controller `POST /order/:id/complete` thin route + `CompleteOrderDto` empty + `assertOwner`; 5) failing ownership `403` + invalid `CANCELLED/FAILED 409` + missing Reservation `404`; 6) idempotent `COMPLETED→COMPLETED 200` no re-mutation; 7) historical price isolation + `GET /order` pagination `COMPLETED` filter; 8) `EXPLAIN` row-level lock + `npm run lint/build/test -- --runInBand` + E2E `register→cart→checkout→complete→GET order`).
