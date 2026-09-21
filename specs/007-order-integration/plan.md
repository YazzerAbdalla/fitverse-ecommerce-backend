# Implementation Plan: Order Integration — Checkout-Only Reservation Refactor (Phase 6)

**Branch**: `007-order-integration` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-order-integration/spec.md` (Phase 6 — `docs/plan.md` §§6.1-6.4 + 9 clarifications Session 2026-09-21: Q1 cart-only A, Q2 reservation atomic A, Q3 productId A, Q4 enum migration A, Q5 defer event B, plus directive checkout-only refactor + Q6 POST blocked User/keep Admin A, Q7 PATCH restrict B, Q8 Order auto-CANCELLED on expiry B, Q9 GET reservationId-only A) + user directive 2026-09-21: **refactor reservation logic to prevent manual user reservation — reservations only via checkout**.

## Summary

Implement the missing Phase 6 checkout that produces a consistent `Order` + `OrderItems` + `Reservation` + `Inventory` state **and** refactor `Reservation` to be **checkout-only**. The refactor removes the user-facing manual reservation race: today's `POST /reservations` (`reservation.controller.ts:23`, `@Auth(User,Admin)`) lets any authenticated user reserve arbitrary `inventoryId`s outside the cart, creating two contending reservation paths (manual vs checkout) that both `FOR UPDATE` the same `Inventory` rows. Even with deterministic locking the dual path doubles API surface, test matrix, and creates phantom holds that bypass cart validation.

Phase 6 V1 will: (a) **remove `POST /reservations` for `User` role** (`@Auth(Admin)` → `201` for Admin, `403 {message:"Use POST /order/checkout"}` for User per Q6/Q8), service `create` → internal `createForCheckout(manager,userId,items,orderId)` called only by `OrderCheckoutService`; (b) **restrict `PATCH /:id/complete|cancel` for User → `403`** per Q7 B (transitions via Order lifecycle Phases 7-8 or Admin/worker only; `GET` remains for owner/Admin, `PATCH /:id/expire` stays Admin), (c) implement cart-only `POST /order/checkout` (`{}` empty body, `forbidNonWhitelisted`) that atomically locks sorted `Inventory` rows → checks `available` → `reservedAmount+=qty` → snapshots `Product.price` → creates `Order PENDING` → `OrderItem` historical → `Reservation RESERVED` with `orderId` in same `DataSource.transaction` → clears cart; (d) **expiration worker also auto-cancels Order `PENDING→CANCELLED`** atomically with `Reservation RESERVED→EXPIRED + reservedAmount-=qty` per Q8 B. Historical price frozen, TTL `15m`, no post-commit `order.created` in Phase 6 (Q5 B). `Order`/`OrderItem` stub fixed (`ManyToMany`→`OneToMany`, `SUCCESS/FAILD→PENDING|COMPLETED|CANCELLED|FAILED`), reads `GET /order` paginated owner-scoped return `reservationId` only per Q9 A.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/common` 11.1.28, `@nestjs/typeorm` 11 + `typeorm` 1.1, `pg` 8.22, `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`, existing `CacheModule` (`@keyv/redis` + `ioredis` 5) and `@nestjs/microservices` (kept but not used for checkout in Phase 6). No new dependency required (BullMQ only for Phase 5 expiration, not checkout).  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; migration `17xxxxx-OrderIntegrationCheckoutOnly` corrects `Order`/`OrderItem`/`OrderStatus` enum; no new Reservation columns; Redis 8 and RabbitMQ 4 remain infra but are **not** touched by checkout transaction per constitution I).  
**Testing**: Jest unit (mocked `EntityManager`, `InventoryService`, `CartService`) + integration/concurrency against **real PostgreSQL** (`--runInBand`, `FOR UPDATE` single-winner), `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`.  
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phase 5, no frontend, worker reuse for expiration.  
**Project Type**: Modular monolithic backend — REST `order` (`POST /order/checkout` new, `GET /order`, `GET /order/:id`) + refactored `reservation` (no user `POST`); GraphQL `products` unchanged.  
**Performance Goals**: Checkout holds row locks <100ms under no contention; `FOR UPDATE` on `Inventory` via `id In(sortedIds)` uses PK index, no table lock; deterministic `inventoryId` sort prevents deadlocks `[A,B]` vs `[B,A]`; availability check is from locked row, never cache. No new 60s SLA beyond expiration's 30s tick (worker unchanged).  
**Constraints**: `synchronize:false` (real migration required); PostgreSQL is authoritative truth (constitution I); cross-module calls via exported services only (`OrderModule` imports `ReservationModule` + `CartModule` + `ProductsModule` + `InventoryModule`); global `ValidationPipe` (`whitelist`+`forbidNonWhitelisted`+`transform`) and `AllExceptionsFilter` remain; `Order.total >=0`, `OrderItem.quantity>0`, `unit_price>=0`, `Inventory` checks already exist; `Cart` never mutates inventory.  
**Scale/Scope**: Touches `src/modules/order/` (new `order-checkout.service.ts` + `order.controller.ts` checkout route + entities fix + migration), `src/modules/reservation/` (controller `POST /` removed/restricted, service `create` refactored to `createForCheckout` internal), `src/modules/cart/` (helper `clearCartForCheckout(manager,userId)` via `EntityManager`), `src/app.module.ts` wiring; 0 new PG tables, 1 migration, 0 new queues. 8 SCs map to 8+ integration/concurrency tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | Checkout availability is `SELECT ... FOR UPDATE` on `Inventory` via `EntityManager` inside `dataSource.transaction`; no Redis/RabbitMQ I/O inside tx. Manual `POST /reservations` removal **reinforces** I by eliminating a cache-bypassable reservation path; Redis never drives eligibility. Post-commit `order.created` is deferred to Phase 11 (Q5 Option B). |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Checkout stays inside single Nest process as `OrderCheckoutService` consuming `ReservationService.createForCheckout(manager,...)` and `CartService.clearCartForCheckout(manager,...)` via exported services; no new service/process, single `OrderModule` owns the transaction. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No new states; only `RESERVED` via checkout (`reservedAmount+=qty`, stock unchanged). Removal of manual `POST` reduces state producers to checkout only, making lifecycle more explicit (`available` remains derived). Enum typo fix `SUCCESS/FAILD→PENDING|COMPLETED|CANCELLED|FAILED` corrects III. |
| **IV. Concurrency safety at DB level (no overselling/double-release)** | ✅ PASS | Core deliverable: checkout per-transaction `FOR UPDATE` Reservation? Actually Inventory only (Reservation is created, not contended) — but inventories are locked sorted, single-winner checkout vs checkout proven via real-PG concurrency test. Removing manual `POST` **eliminates** the manual-checkout race class entirely, leaving only checkout-vs-checkout which is single-winner via same `FOR UPDATE` pattern as Phases 3-4. Deterministic ordering prevents deadlocks. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `OrderCheckoutService` owns orchestration, `ReservationService.createForCheckout(manager,...)` is reused as shared helper (no duplicate `reservedAmount` logic); controller remains thin; `CartService` exposes `clearCartForCheckout(manager)` helper instead of repository injection; no cross-module `@InjectRepository` of another module's entity. `ReservationModule` still `exports:[ReservationService]` for expiration worker. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 13 clarifications (4 original +9 Session 2026-09-21: Q1 cart-only, Q2 atomic, Q3 productId, Q4 enum, Q5 defer, plus Q6 POST block, Q7 PATCH restrict, Q8 auto-cancel, Q9 reservationId-only) done before plan; checkout-only directive and 4 new Qs are documented as clarifications + ADR `docs/decisions/ADR-checkout-only-reservation.md`. Phases 7-11 fan-out remains deferred except Q8 auto-cancel. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Real-PG integration required for checkout atomicity, historical price isolation, `available` rejection rollback, `FOR UPDATE` single-winner checkout vs checkout, opposite-order deadlock avoidance, `EXPLAIN` row-level lock, and verification that `POST /reservations` now returns `403` for User (or 404 if removed). Unit mocks only for guards/DTO. Research D8 mandates `npm run test -- --runInBand`. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | Only `POST /order/checkout` (cart-only, empty `{}`) + `GET /order` + `GET /order/:id` are the new REST contract; removal of `POST /reservations` for User is a **restriction**, not an invention. No payment provider, no new reservation state/column, no `available` stored column. Total is server-calculated `Σ qty*unit_price`. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/007-order-integration/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` Phase 6 exit criterion traceable; ADR for checkout-only reservation recorded. |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (decisions D1-D8 preserve same invariants, removal of manual POST actually reduces risk).

## Project Structure

### Documentation (this feature)

```text
specs/007-order-integration/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8, risks, checkout-only refactor rationale
├── data-model.md        # Phase 1 output — Order/OrderItem fix, Reservation unchanged, CheckoutTransaction model
├── quickstart.md        # Phase 1 output — setup + manual checkout + manual-POST-blocked verification
├── contracts/
│   ├── order-checkout.md        # Phase 1 output — POST /order/checkout (cart-only), GET /order, GET /order/:id
│   └── reservation-refactor.md  # Phase 1 output — POST /reservations removal / 403 for User, internal createForCheckout
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass after 5 clarifies)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── order/
│   │   ├── entities/
│   │   │   ├── order.entity.ts              # FIX — ManyToMany+JoinTable → OneToMany OrderItem, add userId FK, status enum corrected
│   │   │   ├── order-items.entity.ts        # FIX — quantity int CHECK>0, unit_price int/decimal CHECK>=0, productId FK RESTRICT, Unique(orderId,productId), indexes
│   │   │   └── order-status.enum.ts         # NEW or FIX — PENDING|COMPLETED|CANCELLED|FAILED (renamed from SUCCESS/FAILD)
│   │   ├── dto/
│   │   │   ├── checkout.dto.ts              # NEW — empty DTO (no fields, forbidNonWhitelisted, any field → 400)
│   │   │   └── create-order.dto.ts          # REMOVE or DEPRECATE — replaced by CheckoutDto
│   │   ├── order.service.ts                 # REFACTOR — remove stub, keep read methods findAll/findOne with pagination + assertOwner
│   │   ├── order-checkout.service.ts        # NEW — checkout(manager,userId): DataSource.transaction orchestration (lock→check→mutate→Order/OrderItem/Reservation→clear cart)
│   │   ├── order.controller.ts              # MODIFY — add POST /order/checkout (JwtGuard, empty body), GET /order (paginated owner-scoped), GET /order/:id (assertOwner), deprecate old POST /order
│   │   └── order.module.ts                  # MODIFY — imports ReservationModule, CartModule, ProductsModule, InventoryModule, TypeOrmModule.forFeature([Order,OrderItem])
│   ├── reservation/
│   │   ├── reservation.service.ts           # REFACTOR — create(manager,userId,dto) → createForCheckout(manager,userId,items,orderId) internal; keep complete/cancel/expire + expiration worker path; remove public create export for User
│   │   ├── reservation.controller.ts        # MODIFY — REMOVE POST / (or change to @Auth(Admin) + throw 410 Gone for User), keep GET /:id, GET /, PATCH /:id/complete|cancel|expire (complete/cancel may stay but are now internal to order lifecycle; keep for admin/worker)
│   │   ├── entities/
│   │   │   ├── reservation.entity.ts        # unchanged (status, expiresAt, composite index, orderId FK)
│   │   │   ├── reservation-item.entity.ts   # unchanged
│   │   │   └── reservation-status.enum.ts   # unchanged
│   │   ├── dto/create-reservation.dto.ts    # DEPRECATE — no longer exposed via HTTP for User; kept for internal type or removed
│   │   ├── reservation.module.ts            # MODIFY — still exports ReservationService for OrderCheckoutService + ExpirationService
│   │   └── test/
│   │       ├── reservation.integration.spec.ts   # UPDATE — POST /reservations for User → 403/404; keep admin/worker paths
│   │       └── expiration.integration.spec.ts    # unchanged (worker still uses internal createForCheckout path, not HTTP)
│   ├── cart/
│   │   ├── cart.service.ts                  # MODIFY — add clearCartForCheckout(manager, userId): Promise<void> using EntityManager (instead of fire-and-forget deleteCartItemsInBackground)
│   │   └── entities/cart.entity.ts          # unchanged (OneToOne User, OneToMany CartItem)
│   ├── inventory/entities/inventory.entity.ts # unchanged (stock/reservedAmount/available, CHECKs)
│   ├── products/entities/product.entity.ts  # unchanged (price snapshot source)
│   └── app.module.ts                        # MODIFY — ensure OrderModule wiring correct, no BullMQ change
├── migration/                               # NEW — 17xxxxx-OrderIntegrationCheckoutOnly (Order/OrderItem fix + OrderStatus enum)
├── data-source.ts                           # unchanged (synchronize:false)
└── test/app.e2e-spec.ts                     # optional: add checkout e2e (register→add to cart→checkout→GET order→price mutation check)

```

**Structure Decision**: Single project (Option 1) — augment existing `src/modules/order/` with `OrderCheckoutService` + fix entities/migration, and **refactor** `src/modules/reservation/` controller/service to make reservation creation checkout-only (remove user POST, keep internal `createForCheckout`). No new top-level module or PG queue; reuse existing `ReservationService` internal helper and `CartService` `EntityManager` helper, consistent with `AGENTS.md` Transactions rule “caller owns commit/rollback”.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Manual `POST /reservations` removal for User role (breaking API change) | User directive 2026-09-21 to eliminate manual-vs-checkout race by making reservation creation single-path (checkout-only). Dual path (manual + checkout) both `FOR UPDATE` the same `Inventory` rows — even with correct locking it doubles API surface, doubles test matrix, and allows phantom holds that bypass cart validation (`available` pre-check). Single path reduces correctness risk and matches `docs/plan.md` `When does inventory become reserved? → C. When order is created`. | Keeping both paths + adding extra locking would keep 2 producers of `reservedAmount` (manual service + checkout). Alternative “keep POST but add extra guard (check cart equality)” still leaves 2 paths and TOCTOU (cart vs reservation divergence). Removing for User (keep internal `createForCheckout` for checkout/worker) is the smallest breaking change that guarantees one producer of `reservedAmount` in Phase 6. `POST` remains for Admin/internal tests if needed, but returns `403` for User so existing non-checkout tests can still verify 403, not 200. |
| `Order`/`OrderItem` `ManyToMany` → `OneToMany` schema correction + enum typo `SUCCESS/FAILD` → `PENDING|COMPLETED|CANCELLED|FAILED` | Stub is incorrect per `docs/database/overview.md` and spec FR-001/FR-002; leaving it would corrupt checkout FKs and violate principle III (explicit lifecycle) and VIII (no invented stub). Migration is load-bearing and must be done before checkout can persist. | Leaving stub and patching in code (map SUCCESS→COMPLETED) would keep DB typo and `JoinTable` that creates a spurious join table `order_order_items_order_item`; rejected because it hides schema debt and breaks `Unique(orderId,productId)` and `total` FK queries. |

*No other violations — all other gates PASS.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 business clarifications in spec Session 2026-09-21 + checkout-only refactor directive). Key decisions: D1 checkout-only reservation rationale & 403 vs removal, D2 `createForCheckout` internal API, D3 checkout `FOR UPDATE` reuse, D4 single-winner checkout vs checkout, D5 product price snapshot without lock, D6 enum migration, D7 cart-only DTO, D8 real-PG testing + POST-blocked test. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): No new Reservation columns; `Order` fixed to `OneToMany` + `userId FK`, `OrderItem` fixed to `productId FK RESTRICT` + `Unique(orderId,productId)` + CHECKs; `CheckoutTransaction` model `load Cart → sorted FOR UPDATE Inventories → reservedAmount+=qty → Order/OrderItems → Reservation/Items → clear Cart`. Migration `17xxxxx-OrderIntegrationCheckoutOnly`.
- **Contracts** → [contracts/order-checkout.md](./contracts/order-checkout.md): `POST /order/checkout` cart-only empty DTO (`201`/`400`/`409`), `GET /order` paginated, `GET /order/:id` owner check, and [contracts/reservation-refactor.md](./contracts/reservation-refactor.md): `POST /reservations` → `403` for User (or `410` if removed) vs internal `createForCheckout(manager, userId, items, orderId)`.
- **Quickstart** → [quickstart.md](./quickstart.md): Env no new keys, `npm run build/lint`, `docker-compose up -d`, manual curl: `POST /reservations` as User → `403`, `POST /order/checkout` → `201` + `reservedAmount` inc + cart empty, concurrent `Promise.all` single-winner, `npm run test -- --runInBand`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/007-order-integration/plan.md`).

### Agent context update

`AGENTS.md` marker updated via `setup-plan.ps1` + manual correction to this plan (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Checkout-only refactor actually **improves** constitution IV (single producer of `reservedAmount`) and V (single orchestration site). Q1-Q5 clarifications + directive are consistent with constitution I/III/IV/VII and do not introduce new state or cache-based availability.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 6 into ordered tasks (e.g.: 1) failing integration test `POST /reservations` as User → `403` after refactor; 2) failing checkout atomic test (cart A2 B1 → Order PENDING 250 → Reservation RESERVED → reservedAmount 0→2); 3) implement `Order`/`OrderItem` entity fixes + migration + `OrderStatus` enum; 4) implement `OrderCheckoutService` `dataSource.transaction` with sorted `FOR UPDATE` + `createForCheckout` reuse; 5) refactor `ReservationController` `POST` removal + `ReservationService` internalization + `CartService.clearCartForCheckout`; 6) failing concurrent checkout vs checkout single-winner + opposite-order deadlock test; 7) historical price isolation + empty/insufficient `400`/`409` rollback tests; 8) pagination read tests; 9) `EXPLAIN` + `npm run lint/build/test -- --runInBand` + E2E `register→cart→checkout→GET order`).

