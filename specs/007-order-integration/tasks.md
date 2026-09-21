---
description: "Task list for Order Integration — Checkout-Only Reservation Refactor"
---

# Tasks: Order Integration — Checkout-Only Reservation Refactor (007-order-integration)

**Input**: Design documents from `/specs/007-order-integration/` — `plan.md` (checkout-only refactor), `spec.md` (US1 P1, US2 P1, US3 P2, 13 clarifications 2026-09-21), `research.md` (D1-D9), `data-model.md` (Order/OrderItem fix, CheckoutTransaction, expiration auto-cancel), `contracts/order-checkout.md` + `contracts/reservation-refactor.md`, `quickstart.md`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Tests**: Included (constitution VII mandates real-PG integration + concurrency + `--runInBand`)
**Organization**: Grouped by user story; Foundational must complete before any story; each story independently testable

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify branch, dependencies, and env before touching domain code

- [ ] T001 Verify branch `007-order-integration` and `.specify/feature.json` points to `specs/007-order-integration` in `D:\Projects\mini-e-commerce\.specify\feature.json`
- [ ] T002 [P] Install and verify dependencies `npm ci` and `npm run build` passes in `package.json`
- [ ] T003 [P] Verify Docker infra `docker-compose up -d` (postgres, redis, rabbitmq) and `npm run lint` passes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Correct blocking schema and refactor Reservation to checkout-only — MUST complete before ANY checkout story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Fix `OrderStatus` enum typo in `src/modules/order/order-status.enum.ts` to `PENDING|COMPLETED|CANCELLED|FAILED` (rename `SUCCESS→COMPLETED`, `FAILD→FAILED`, add `CANCELLED`)
- [ ] T005 [P] Fix `Order` entity `src/modules/order/entities/order.entity.ts` — remove `ManyToMany` + `@JoinTable`, add `ManyToOne User` with `JoinColumn(userId)`, `@Index(['userId'])`, `@Index(['status'])`, `total` `CHECK >=0`, `OneToMany` `orderItems`, correct relations per `data-model.md:15`
- [ ] T006 [P] Fix `OrderItem` entity `src/modules/order/entities/order-items.entity.ts` — add `orderId` FK `ON DELETE CASCADE` `@Index`, `productId` FK `ON DELETE RESTRICT` `@Index`, `@Unique(['orderId','productId'])`, `@Check quantity>0`, `@Check unit_price>=0`, relations per `data-model.md:24`
- [ ] T007 Create migration `src/migration/17xxxxx-OrderIntegrationCheckoutOnly.ts` for Order/OrderItem/OrderStatus fix (drop spurious `order_order_items_order_item` join table, alter enum, add FKs/constraints/indexes, `synchronize:false`)
- [ ] T008 Refactor `ReservationService` `src/modules/reservation/reservation.service.ts` — keep `create` for Admin/internal but add `createForCheckout(manager:EntityManager, userId:string, items:{inventoryId,quantity}[], orderId:string):Promise<Reservation>` per `research.md:D2`, no re-lock, validates `quantity>0` + duplicate `inventoryId`, creates `Reservation` `RESERVED` + `ReservationItem[]` with `orderId` via `manager`
- [ ] T009 Refactor `ReservationController` `src/modules/reservation/reservation.controller.ts` — change `@Post()` from `@Auth(User,Admin)` to `@Auth(Admin)` returning `403 {message:"Reservation can only be created via POST /order/checkout"}` for `User` (or delete route returning `404`), keep `GET /:id`, `GET /`, `PATCH /:id/expire` (Admin), and restrict `PATCH /:id/complete|cancel` to `403` for `User` per `spec.md:236` Q7 B (only Admin/worker/internal Order service)
- [ ] T010 Modify `CartService` `src/modules/cart/cart.service.ts` — add `clearCartForCheckout(manager:EntityManager, userId:string):Promise<void>` using `manager.delete(CartItem,{cart:{id}})` (replace fire-and-forget `deleteCartItemsInBackground`), keep existing `getUserCart`/`addCartItem` optimistic `available` checks
- [ ] T011 Update `ReservationModule` `src/modules/reservation/reservation.module.ts` to still export `ReservationService` for `OrderCheckoutService` + `ReservationExpirationService`, and `OrderModule` `src/modules/order/order.module.ts` to import `ReservationModule`, `CartModule`, `ProductsModule`, `InventoryModule`, `TypeOrmModule.forFeature([Order,OrderItem])`
- [ ] T012 [P] Update DTOs — create empty `src/modules/order/dto/checkout.dto.ts` (`class CheckoutDto {}` no fields, `forbidNonWhitelisted` rejects any `items[]`/`orderId`/`reservationId`) and deprecate `src/modules/order/dto/create-order.dto.ts` (keep empty but not used)

**Checkpoint**: Foundation ready — Order schema correct, Reservation checkout-only, Cart helper available — user story implementation can now begin

---

## Phase 3: User Story 1 — Checkout creates Order + OrderItems + Reservation atomically (Priority: P1) 🎯 MVP

**Goal**: Cart-only `POST /order/checkout` creates consistent state in one transaction per `spec.md:31` US1 and `contracts/order-checkout.md:10`

**Independent Test**: Seed 2 products + inventories (A price100, B price50), create user, `POST /cart/items` A qty2 + B qty1, `POST /order/checkout` `{}` → `201` `Order PENDING total250` + 2 `OrderItems` snapshot + `Reservation RESERVED` `orderId` + inventories `reservedAmount` inc + cart empty; change `Product.price` to 999 → `GET /order/:id` `unitPrice` stays 100/50 per `spec.md:41`

### Tests for User Story 1 ⚠️ Write first, ensure FAIL before implementation

- [ ] T013 [P] [US1] Contract test for `POST /order/checkout` empty body validation in `src/modules/order/test/checkout.contract.spec.ts` — any `items[]`/`orderId` → `400`
- [ ] T014 [P] [US1] Integration test (real PG) checkout atomic happy path in `src/modules/order/test/checkout.integration.spec.ts` — asserts Order + OrderItem + Reservation + Inventory + cart empty per `spec.md:41` SC-001
- [ ] T015 [P] [US1] Integration test checkout empty cart → `400` and `available < qty` → `409` rollback no side effects in `src/modules/order/test/checkout.integration.spec.ts` per `spec.md:43`/`44`

### Implementation for User Story 1

- [ ] T016 [US1] Implement `OrderCheckoutService` `src/modules/order/order-checkout.service.ts` — `checkout(userId:string):Promise<{order, reservation}>` orchestrating `dataSource.transaction(async manager=>{...})` per `data-model.md:126` (load Cart via `manager`, `sortedIds` deterministic, `FOR UPDATE` Inventories, `available` check `stock-reservedAmount`, `reservedAmount+=qty`, `Product.price` snapshot, create `Order` + `OrderItem[]` + `createForCheckout` without re-lock, `clearCartForCheckout`) with JSDoc `/** This service is responsible for ... */` per `AGENTS.md:3`
- [ ] T017 [US1] Implement `OrderService` reads `src/modules/order/order.service.ts` — `findAll(userId, pagination, role)` paginated `owner-scoped` (`where:{userId}` unless Admin `userId` filter) + `findOne(userId,id,role)` with `assertOwner` per `spec.md:132` FR-007, using `Repository` + `relations` for `orderItems`
- [ ] T018 [US1] Implement `OrderController` `src/modules/order/order.controller.ts` — `POST /order/checkout` `@Auth()` empty `CheckoutDto` → `OrderCheckoutService.checkout`, `GET /order` paginated, `GET /order/:id` owner check, `@ApiBearerAuth`/`@ApiOperation` per `contracts/order-checkout.md:10`
- [ ] T019 [US1] Wire `OrderModule` providers `OrderCheckoutService` + `OrderService` and exports if needed, ensure `AppModule` imports `OrderModule` correctly
- [ ] T020 [US1] Add logging via injected `Logger` and inline `//` comments for `available`/`sortedIds`/`total` formulas per `AGENTS.md:3`

**Checkpoint**: At this point, US1 checkout atomic is fully functional and testable independently via `POST /order/checkout` → `201` and real-PG integration `npm run test -- --runInBand src/modules/order/test/checkout.integration.spec.ts`

---

## Phase 4: User Story 2 — Concurrent checkout race: single winner on last unit (Priority: P1)

**Goal**: `FOR UPDATE` single-winner proven when two shoppers race for last available unit per `spec.md:48` US2 and `data-model.md:126`

**Independent Test**: `A stock10 reserved9 available1` two users each cart `A qty1` fire `Promise.all([checkout(u1),checkout(u2)])` via `dataSource.transaction` real PG `--runInBand` → one `201` one `409` + exactly one `reservedAmount` inc per `spec.md:56`

### Tests for User Story 2 ⚠️

- [ ] T021 [P] [US2] Integration concurrency test single-winner checkout vs checkout in `src/modules/order/test/checkout-concurrency.integration.spec.ts` — `available1` two `qty1` → one `201` one `409` SC-003
- [ ] T022 [P] [US2] Integration deadlock-avoidance test opposite order `[A,B]` vs `[B,A]` in `src/modules/order/test/checkout-concurrency.integration.spec.ts` per `spec.md:60` SC-007 (no hang, `Promise.all` with `sortedIds`)
- [ ] T023 [P] [US2] Integration test checkout retry after `409` still `409` until inventory released in `src/modules/order/test/checkout.integration.spec.ts` per `spec.md:61`

### Implementation for User Story 2

- [ ] T024 [US2] Verify `OrderCheckoutService` already uses deterministic `sortedIds = [...new Set(ids)].sort()` and `FOR UPDATE` per `plan.md:20`; add inline comment `// deterministic lock ordering to prevent deadlock when carts have opposite item order` if missing, no new file if already correct — validate in `src/modules/order/order-checkout.service.ts`
- [ ] T025 [US2] Ensure `available = stock - reservedAmount` check uses locked row value `inventory.available` (getter) with comment `// Available excludes already-reserved units to prevent overselling` in `src/modules/order/order-checkout.service.ts`

**Checkpoint**: At this point, US1 and US2 both work independently; `npm run test -- --runInBand src/modules/order/test/checkout-concurrency.integration.spec.ts` passes

---

## Phase 5: User Story 3 — Order retrieval, pagination, and ownership (Priority: P2)

**Goal**: User lists/fetches own orders, admin can inspect any, `GET /order/:id` returns `reservationId` only per `spec.md:64` US3 and `spec.md:237` Q9 A

**Independent Test**: Create 3 orders for U1 via checkout, `GET /order?page=1&limit=2` as U1 → `data.length2 meta.totalItems3`, `GET /order/:id` as owner `200` with `reservationId`, as U2 `403`, as Admin `200` per `spec.md:75`

### Tests for User Story 3 ⚠️

- [ ] T026 [P] [US3] Integration test `GET /order` pagination `page/limit` meta shape in `src/modules/order/test/order-read.integration.spec.ts` per `spec.md:75` SC-006
- [ ] T027 [P] [US3] Integration test `GET /order/:id` ownership `403` vs Admin `200` in `src/modules/order/test/order-read.integration.spec.ts` per `spec.md:76`
- [ ] T028 [P] [US3] Integration test historical price isolation remains after reads in `src/modules/order/test/order-read.integration.spec.ts` per `spec.md:77` (product price 999 does not affect stored `unitPrice`)

### Implementation for User Story 3

- [ ] T029 [US3] Ensure `GET /order` `GET /order/:id` already implemented in T017/T018; add `reservationId` (and `expiresAt`) lookup via `Reservation` `orderId` FK using `manager` or `Repository` without eager join, return `{..., reservationId, expiresAt}` per Q9 `contracts/order-checkout.md:20`
- [ ] T030 [US3] Add `@ApiOperation`/`@ApiResponse` Swagger docs for `GET` routes in `src/modules/order/order.controller.ts` and pagination DTO reuse `src/modules/products/dto/pagination.dto.ts` shape

**Checkpoint**: All user stories independently functional; `npm run test -- --runInBand src/modules/order/test/order-read.integration.spec.ts` passes

---

## Phase 6: Polish & Cross-Cutting Concerns — Checkout-Only Refactor + Expiration Coupling

**Purpose**: Close Phase 6 with refactored reservation verification, Order auto-cancel on expiry, and validation

- [ ] T031 Update existing `Reservation` integration tests `src/modules/reservation/test/reservation.integration.spec.ts` — `POST /reservations` as User → expect `403` (`Use POST /order/checkout`) per `spec.md:236` Q6, Admin → `201`; `PATCH /:id/complete|cancel` as User on checkout-created reservation → `403` per Q7 B
- [ ] T032 Extend `ReservationExpirationService` `src/modules/reservation/reservation-expiration.service.ts` and `ReservationExpirationProcessor` `src/modules/reservation/reservation-expiration.processor.ts` to auto-cancel Order `PENDING→CANCELLED` atomically with `Reservation RESERVED→EXPIRED` per `spec.md:237` Q8 B and `data-model.md:173` (lock `Reservation FOR UPDATE` → `Inventories FOR UPDATE` → `reservedAmount-=qty` → `Reservation EXPIRED` → `Order CANCELLED` same `manager` commit) with per-candidate continue-on-failure and logging
- [ ] T033 Add integration test for Order auto-cancel on expiry in `src/modules/order/test/checkout-expiration.integration.spec.ts` — create via checkout (`expiresAt = now -1m` via direct DB update for test) → worker `processExpiredBatch` → `Reservation EXPIRED` + `reservedAmount` released + `Order CANCELLED` per `spec.md:96` new edge
- [ ] T034 Run `EXPLAIN` verification for checkout `SELECT ... FOR UPDATE` row-level lock in `src/modules/order/test/checkout.integration.spec.ts` per `spec.md:175` SC-008 (assert `Index Scan` on `Inventory` PK, no seq scan)
- [ ] T035 [P] Update `docs/plan.md` Phase 6 exit criteria marker to DONE after verification and add ADR `docs/decisions/ADR-checkout-only-reservation.md` describing checkout-only rationale and Q6-Q9 decisions
- [ ] T036 Run verification `npm run lint`, `npm run build`, `npm run test -- --runInBand`, `npm run test:e2e` (register→cart→checkout→GET order→GET reservation→price mutation→expiry→CANCELLED)
- [ ] T037 [P] Run `quickstart.md` manual validation: `docker-compose up -d`, curl checks 4.1 User `POST /reservations` → `403`, 4.2 happy checkout → `201`, 4.3 explicit `items[]` → `400`, 4.5 historical price + 4.6 Order auto-cancel

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories (Order schema + Reservation refactor must be correct before checkout transactions)
- **User Stories (Phase 3+)**: All depend on Foundational completion
  - US1 (P1) checkout atomic → MVP, no deps on other stories
  - US2 (P1) concurrent race → depends on US1 implementation (reuses `OrderCheckoutService` + adds deterministic lock comments); can start in parallel after Foundational but will fail until T016 done
  - US3 (P2) retrieval → depends on US1 (needs Orders to exist); can start after US1 checkpoint
- **Polish (Phase 6)**: Depends on US1-US3 complete; includes Reservation test updates, Order auto-cancel, EXPLAIN, docs, verification

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **US2 (P1)**: Can start after Foundational (Phase 2) - Technically independent but reuses `OrderCheckoutService` from US1, so sequential after T016 is practical; tests are independent
- **US3 (P2)**: Can start after Foundational (Phase 2) + US1 data (needs at least one Order) - May integrate with US1 but independently testable via checkout helper

### Within Each User Story

- Tests MUST be written and FAIL before implementation (T013-T015 before T016, T021-T023 before T024)
- Foundational entities/migration (T004-T007) before services (T008-T010) before controllers (T011)
- Services before endpoints, core checkout before concurrency verification

### Parallel Opportunities

- All Setup [P] tasks (T002, T003) can run in parallel
- All Foundational [P] entity fixes (T005, T006) can run in parallel (different files)
- All contract/integration tests for a story marked [P] (T013-T015, T021-T023, T026-T028) can run in parallel once Foundational done
- US1, US2, US3 implementation by different developers can proceed in parallel after Foundational, but US2/US3 will be blocked until US1's `OrderCheckoutService` exists
- Different user stories can be worked on in parallel by different team members after Foundational

---

## Parallel Example: Foundational Phase

```bash
# Launch entity fixes together (different files, no deps):
Task T005 Fix Order entity in src/modules/order/entities/order.entity.ts
Task T006 Fix OrderItem entity in src/modules/order/entities/order-items.entity.ts

# Launch tests for US1 together after Foundational:
Task T013 Contract test POST /order/checkout in src/modules/order/test/checkout.contract.spec.ts
Task T014 Integration test checkout atomic in src/modules/order/test/checkout.integration.spec.ts
Task T015 Integration test empty/409 in src/modules/order/test/checkout.integration.spec.ts
```

## Parallel Example: User Story 1

```bash
# Launch all US1 tests together:
Task: "Contract test for POST /order/checkout in src/modules/order/test/checkout.contract.spec.ts"
Task: "Integration test checkout atomic in src/modules/order/test/checkout.integration.spec.ts"
Task: "Integration test empty cart 400 in src/modules/order/test/checkout.integration.spec.ts"

# After tests fail, launch implementations:
Task: "Implement OrderCheckoutService in src/modules/order/order-checkout.service.ts"
Task: "Implement OrderService reads in src/modules/order/order.service.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only) — Minimal Phase 6 Exit

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T012) — Order schema correct, Reservation checkout-only, Cart helper
3. Complete Phase 3: US1 (T013-T020) — cart-only checkout atomic
4. **STOP and VALIDATE**: `npm run test -- --runInBand src/modules/order/test/checkout.integration.spec.ts` → `POST /order/checkout` `201` SC-001/SC-004/SC-005 pass; manual `POST /reservations` as User → `403` per T031 quick check; `npm run lint` + `npm run build` pass
5. Deploy/demo if ready — exit criterion "successful checkout produces consistent Order+OrderItems+Reservation+Inventory" is met

### Incremental Delivery

1. Setup + Foundational → Foundation ready (T001-T012 pass)
2. Add US1 → Test independently → Demo checkout atomic (MVP!)
3. Add US2 → Test concurrency → Demo single-winner (no oversell)
4. Add US3 → Test retrieval → Demo pagination/ownership
5. Polish → Add Order auto-cancel on expiry (Q8), update docs, run full `npm run test -- --runInBand` + `quickstart.md` → Phase 6 DONE, update `docs/plan.md` exit marker

### Parallel Team Strategy

With multiple developers after Foundational:

1. Team completes Setup + Foundational together (T001-T012)
2. Once Foundational is done:
   - Developer A: US1 `OrderCheckoutService` + controller (T016-T020)
   - Developer B: US2 concurrency tests + lock verification (T021-T025) — will wait for A's service to exist but can draft tests in parallel
   - Developer C: US3 read endpoints + pagination (T026-T030) — can draft tests, needs US1 data
3. Stories integrate via shared `OrderCheckoutService` and `ReservationService.createForCheckout`

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability (Foundational has no label)
- Each user story independently completable and testable — US1 checkout can be validated without US2 concurrency or US3 retrieval, but US2/US3 need US1's checkout to create data
- Verify tests fail before implementing (fail fast on real PG with `--runInBand`)
- Commit after each task or logical group (e.g., after T004-T007 migration, after T008-T009 refactor)
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence; checkout transaction must remain the sole `reservedAmount` producer after refactor
