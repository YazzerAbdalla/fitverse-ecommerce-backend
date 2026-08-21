# Tasks: Inventory Foundation (Phase 1)

**Input**: Design documents from `/specs/001-inventory-foundation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/inventory-api.md, quickstart.md

**Tests**: Included — explicitly requested in spec FR7 and required by the constitution (Principle VII). Integration tests run against a real PostgreSQL.

**Organization**: Tasks grouped by user story so each story is independently implementable and testable.

**Feature path root**: `src/modules/inventory/`

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to (US1–US4)
- Exact file paths included in every task

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm environment and review existing code before changes (Manual Development Rule step 1).

- [x] T001 Review existing Product entity and InventoryService to understand current stock handling in `src/modules/products/entities/product.entity.ts` and `src/modules/inventory/inventory.service.ts`
- [x] T002 [P] Confirm local infrastructure is up (`docker-compose up -d` for postgres/redis/rabbitmq) and DB is reachable for integration tests

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `Inventory` entity and relation MUST exist before any user story work. No story label (foundational).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Create `Inventory` entity with `id`, `productId`, `stock`, `reservedAmount`, `createdAt`, `updatedAt`, `@Check` constraints (`stock >= 0`, `reservedAmount >= 0`, `reservedAmount <= stock`), `@Unique` on `productId`, `@Index` on `productId`, and a derived `available` getter in `src/modules/inventory/entities/inventory.entity.ts`
- [x] T004 Add inverse read-only `@OneToOne(() => Inventory)` relation to `Product` in `src/modules/products/entities/product.entity.ts` (keep `stock` column for now — removed in US1)
- [x] T005 Register `Inventory` entity / repository provider in `src/modules/inventory/inventory.module.ts` (import `ProductsModule`)

**Checkpoint**: Inventory entity exists with constraints; Product links back. User stories can now begin.

---

## Phase 3: User Story 1 — Inventory Exists & Product.stock Reconciled (Priority: P1) 🎯 MVP

**Goal**: Every product owns inventory in the `Inventory` domain — both existing products (seeded) and any product created hereafter — and `Product.stock` is removed so Inventory is the sole source of truth.

**Independent Test**: For every existing `Product`, exactly one `Inventory` row exists with `stock` equal to the former `Product.stock` and `reservedAmount = 0`; any newly created `Product` automatically gets an `Inventory` row; `Product` no longer has a `stock` field; `Inventory.available === stock - reservedAmount`.

### Implementation for User Story 1

- [x] T006 [US1] Implement `InventorySeeder` (idempotent, runs once via `onModuleInit`) that creates one `Inventory` per `Product`, copying `Product.stock` → `stock`, `reservedAmount = 0`, in `src/modules/inventory/inventory.seeder.ts`. Guard: skip products that already have an `Inventory`, and tolerate the `Product.stock` column already being removed on later runs.
- [x] T007 [US1] Wire `InventorySeeder` into `InventoryModule.onModuleInit` in `src/modules/inventory/inventory.module.ts` (idempotent guard so re-boots do not fail or duplicate).
- [x] T008 [US1] Ensure new-product creation auto-creates inventory: `ProductsModule` imports `InventoryModule`; `ProductsService.create` (GraphQL) calls `InventoryService.createForProduct(productId, initialStock = 0)` so every newly created `Product` gets an `Inventory` row. Add `createForProduct` to `src/modules/inventory/inventory.service.ts` and export the service.
- [x] T009 [US1] Remove `stock` column and its `@Check('"stock" >= 0')` from `Product` entity in `src/modules/products/entities/product.entity.ts` (only after the seeder has run once and new-product creation is wired).

**Checkpoint**: Inventory is the authoritative stock owner for existing and new products; no `Product.stock` remains. MVP demonstrable.

---

## Phase 4: User Story 2 — Inventory Business Operations (Priority: P1)

**Goal**: Expose inventory behavior through `InventoryService` so other modules (order, later reservation) never mutate inventory columns directly.

**Independent Test**: `getInventory` returns the record; `checkAvailability(p, q)` returns true only when `available >= q`; `increaseStock`/`decreaseStock` update `stock` and throw `ConflictException` when would violate `stock >= 0`; `decreaseStockForOrderMany`/`restoreStockForOrderMany` now target `Inventory`.

### Implementation for User Story 2

- [x] T010 [US2] Implement `getInventory(productId)` and `checkAvailability(productId, qty)` in `src/modules/inventory/inventory.service.ts`
- [x] T011 [US2] Implement `increaseStock(productId, qty)` and `decreaseStock(productId, qty)` with invariant checks and `ConflictException` on violation in `src/modules/inventory/inventory.service.ts`
- [x] T012 [US2] Redirect `decreaseStockForOrderMany` / `restoreStockForOrderMany` to operate on `Inventory`: change their parameter type from `Array<Pick<Product, 'id' | 'stock'> & { soldQuantity: number }>` to `Array<Pick<Inventory, 'id' | 'stock'> & { soldQuantity: number }>` and persist via `manager.getRepository(Inventory)` in `src/modules/inventory/inventory.service.ts`
- [x] T013 [US2] Add stub `reserve(productId, qty)` / `releaseReservation(productId, qty)` / `completeSale(productId, qty)` with correct inventory math (transactional locking wired in Phase 3/4) in `src/modules/inventory/inventory.service.ts`
- [x] T014 [US2] Ensure `InventoryService` is exported from `InventoryModule` in `src/modules/inventory/inventory.module.ts`

**Checkpoint**: Other modules can use `InventoryService` for all stock/reservation math.

---

## Phase 5: User Story 3 — Inventory REST API (Priority: P1)

**Goal**: A thin REST controller exposes inventory reads and stock adjustments per `contracts/inventory-api.md`.

**Independent Test**: `GET /inventory/:productId` returns `{ id, productId, stock, reservedAmount, available, ... }`; `GET /inventory/:productId/availability?quantity=q` returns sufficiency; `POST .../increase` and `POST .../decrease` adjust stock; invalid quantity → 400, over-decrease → 409.

### Implementation for User Story 3

- [x] T015 [US3] Create DTOs `IncreaseStockDto`/`DecreaseStockDto` (`quantity: number`, `@IsInt() @Min(1)`) and a response DTO in `src/modules/inventory/dto/`
- [x] T016 [US3] Implement `inventory.controller.ts` with `GET /inventory/:productId`, `GET /inventory/:productId/availability`, `POST /inventory/:productId/increase`, `POST /inventory/:productId/decrease` (thin; `@Auth` protected) per `contracts/inventory-api.md` in `src/modules/inventory/inventory.controller.ts`
- [x] T017 [US3] Register the controller in `InventoryModule` in `src/modules/inventory/inventory.module.ts`

**Checkpoint**: Inventory is queryable/adjustable via REST; controller holds no business logic.

---

## Phase 6: User Story 4 — Tests & Verification (Priority: P2)

**Goal**: Validate constraints, derived `available`, and service behavior per spec FR7 and constitution Principle VII.

**Independent Test**: Unit tests pass with mocks; integration tests against real PostgreSQL prove DB rejects `stock < 0`, `reservedAmount < 0`, `reservedAmount > stock`, enforces one-inventory-per-product, `available = stock - reservedAmount`, and that `Product` no longer exposes a `stock` field.

### Tests for User Story 4

- [x] T018 [US4] Write/expand unit tests for `InventoryService` math and error throwing in `src/modules/inventory/inventory.service.spec.ts`; include an assertion that `Product` (imported entity) has no `stock` property and no code path reads it.
- [x] T019 [US4] Write integration tests (real PostgreSQL) asserting `@Check` constraints, `productId` uniqueness, `available` derivation, and that the `Product` table/entity has no `stock` column, in `src/modules/inventory/test/inventory.integration.spec.ts`
- [x] T020 [P] [US4] Run `npm run lint`, `npm run build`, `npm run test` and confirm all green

**Checkpoint**: Behavior is verified against the real database; constraints enforced; `Product.stock` removal verified.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and decision records required by constitution Principle IX.

- [x] T021 [P] Update `AGENTS.md` module map: `inventory` now has an entity, service, and REST API
- [x] T022 [P] Add/refresh `docs/architecture/inventory.md` describing the Inventory domain
- [x] T023 [P] Record the `Product.stock` removal decision as an ADR in `docs/decisions/`
- [x] T024 Run `quickstart.md` validation end-to-end and confirm migration note (disable `synchronize` + add real migration before prod)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **US1 (Phase 3)**: Depends on Foundational (needs the `Inventory` entity to seed/wire into).
- **US2 (Phase 4)**: Depends on Foundational; can start as soon as entity exists (does not need US1).
- **US3 (Phase 5)**: Depends on US2 (controller calls the service).
- **US4 (Phase 6)**: Depends on US1–US3 implementations to test.
- **Polish (Phase 7)**: Depends on all user stories complete.

### User Story Dependencies

- **US1 (P1, MVP)**: After Foundational. Independent of US2/US3.
- **US2 (P1)**: After Foundational. Independent of US1 (different concern) but both touch `inventory.service.ts` / `product.entity.ts`.
- **US3 (P1)**: After US2 (needs service methods).
- **US4 (P2)**: After US1–US3 (tests real behavior).

### Within Each User Story

- Models/entity before service (Foundational before US1/US2).
- Service before controller (US2 before US3).
- Tests (US4) written after implementation they cover; integration tests require real PostgreSQL.

### Parallel Opportunities

- Setup tasks T001/T002 can run in parallel.
- Foundational T003/T004/T005: T004 touches `Product`, T003 creates the entity; can be parallelized by separate files but T005 needs both.
- US2 and US1 can be developed in parallel by different developers once Foundational is done (both modify `inventory.service.ts`/`product.entity.ts` — coordinate to avoid file conflicts).
- US4 tests T018/T019 can run in parallel; T020 is a final gate.

---

## Parallel Example: User Story 1 (MVP)

```bash
# After Foundational (T003-T005) completes:
Task T006: "Implement InventorySeeder ... src/modules/inventory/inventory.seeder.ts"
Task T007: "Wire InventorySeeder into InventoryModule.onModuleInit ... src/modules/inventory/inventory.module.ts"
Task T008: "Ensure new-product creation auto-creates inventory ... src/modules/inventory/inventory.service.ts + ProductsService.create"
Task T009: "Remove stock column from Product ... src/modules/products/entities/product.entity.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T005) — CRITICAL, blocks all stories
3. Complete Phase 3: User Story 1 (T006–T009)
4. **STOP and VALIDATE**: Confirm every existing and newly created Product has an Inventory row, `Product.stock` gone, `available` derived.
5. Proceed to US2/US3/US4.

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → inventory authoritative (MVP)
3. US2 → business operations
4. US3 → REST API
5. US4 → tests
6. Polish → docs/ADR

### Parallel Team Strategy

1. Team completes Setup + Foundational together.
2. Once Foundational done: Developer A → US1, Developer B → US2 (coordinate `inventory.service.ts`/`product.entity.ts` edits).
3. US3/US4 follow sequentially after their dependencies.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to a user story for traceability.
- Spec FR7 explicitly requires tests → included in US4.
- Seed BEFORE removing `Product.stock` to avoid data loss (research R6); seeder is idempotent (C1).
- New products MUST auto-create inventory (A1) or they ship with zero inventory.
- `available` is derived; never persist as a mutable column (constitution III).
- Other modules must call `InventoryService`, never `@InjectRepository(Inventory)`.
- Concurrency/locking is Phase 3 — do not add pessimistic locking here.
