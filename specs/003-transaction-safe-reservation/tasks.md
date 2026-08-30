# Tasks: Transaction-Safe Reservation (Phase 3)

**Input**: Design documents from `specs/003-transaction-safe-reservation/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/reservation-api.md`, `quickstart.md`)
**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `data-model.md`, `contracts/`, `quickstart.md`
**Branch**: `003-transaction-safe-reservation` | **Date**: 2026-08-30
**Tests**: Included — spec FR-010 mandates real PostgreSQL concurrency/rollback tests; do NOT mock the database for consistency assertions.
**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify foundation so a cheap model has zero guesswork; no code change in this phase except confirming prerequisites.

- [ ] T001 Verify branch and feature directory in `D:\Projects\mini-e-commerce` — run `git branch --show-current` must be `003-transaction-safe-reservation` and `cat .specify/feature.json` must contain `specs/003-transaction-safe-reservation`; also `ls specs/003-transaction-safe-reservation/spec.md` and `plan.md` exist
- [ ] T002 Verify PostgreSQL docker and env in `D:\Projects\mini-e-commerce` — run `docker compose ps` (postgres up), `cat .env` has `POSTGRES_*`, run `npm run build` must pass with zero errors before any code change
- [ ] T003 Confirm no new migration is needed for Phase 3 in `src/data-source.ts` — open the file, verify `synchronize: false`, verify existing migration `1755850000000-CreateReservationAndReservationItem` already creates `Reservation`/`ReservationItem`/`Inventory` tables; document that Phase 3 uses existing `Inventory`/`Reservation`/`ReservationItem` only (spec A8, `data-model.md` §6)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Blocking setup that MUST complete before ANY user story work can begin. Only after this phase can US1/US2/US3 start.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T004 [P] Read and annotate the exact precedent pattern in `src/modules/products/products.service.ts:225` — open the file, note the `dataSource.transaction(async (manager) => manager.find(Product, { where: { id: In(productIds) }, lock: { mode: 'pessimistic_write' } }))` + `manager.save(Product, ...)` pattern; copy the import line `import { In } from 'typeorm'` for reuse in `reservation.service.ts`
- [ ] T005 [P] Read current implementation in `src/modules/reservation/reservation.service.ts:46-113` — note the current `create()` does `manager.getRepository(Inventory).findOne` per item WITHOUT locking, WITHOUT availability check, WITHOUT `reservedAmount` increment; note imports already present (`ConflictException`, `DataSource`, `EntityManager`, `Inventory`, `Order`, `Reservation`, `ReservationItem`) and that `DataSource` is injected as `public readonly dataSource`
- [ ] T006 [P] Read controller wrapping in `src/modules/reservation/reservation.controller.ts:24-30` — confirm `POST /reservations` is `return this.reservationService.dataSource.transaction((manager) => this.reservationService.create(manager, userId, dto))`; confirm NO change needed here, only service will be augmented
- [ ] T007 Read entity getters and constraints in `src/modules/inventory/entities/inventory.entity.ts:44-46` — confirm `get available() { return this.stock - this.reservedAmount; }` and `@Check("stock" >=0)`, `@Check("reservedAmount" >=0)`, `@Check("reservedAmount" <= "stock")`; confirm these CHECKs are the DB backstop for FR-007

**Checkpoint**: Foundation ready — cheap model now knows the exact locking precedent, the exact service method to augment, and that no migration/DTO/entity change is needed. User story implementation can now begin.

---

## Phase 3: User Story 1 — Atomic reservation creation with inventory hold (Priority: P1) 🎯 MVP

**Goal**: A shopper creates a reservation for 1..N inventories; if `available >= requested` for EVERY item, the system atomically increments `reservedAmount` and persists `Reservation`+`ReservationItem`s inside a single `FOR UPDATE` transaction. Delivers the core `no-oversell` primitive for single-request correctness.

**Independent Test**: Create reservation with 2 items within available (e.g., A stock=10 reserved=2 available=8 + B stock=5 reserved=0) with `{items:[{A,3},{B,2}]}` → `201`, `A.reservedAmount` becomes 5, `B` becomes 2, reservation queryable by id. Request exceeding available (available=2, qty=3) → `409`, no side effect.

### Tests for User Story 1 (write FIRST, ensure they FAIL before implementation)

- [ ] T008 [P] [US1] Add unit test for happy-path atomic increment in `src/modules/reservation/reservation.service.spec.ts` — in `describe('create')` add a test that mocks `EntityManager` with `find` returning locked inventories `{id: inv-1, stock:10, reservedAmount:2, get available(){return 8}}` and `{id: inv-2, stock:5, reservedAmount:0, get available(){return 5}}`, calls `service.create(manager, userId, {items:[{inventoryId:inv-1,quantity:3},{inventoryId:inv-2,quantity:2}]})`, expects `manager.find` called with `{where:{id: In(sortedIds)}, lock:{mode:'pessimistic_write'}}`, expects saved inventories have `reservedAmount` 5 and 2, expects reservation created with `status RESERVED`; this test MUST fail before T009-T014
- [ ] T009 [P] [US1] Add unit test for insufficient available rejection in `src/modules/reservation/reservation.service.spec.ts` — add test with locked inventory `{stock:10, reservedAmount:8, available:2}` and dto qty=3, expects `service.create` throws `ConflictException` with message containing `Insufficient available inventory` and `Available: 2, requested: 3`, and `manager.save` for `Reservation` is never called
- [ ] T010 [P] [US1] Add unit test for multi-item partial failure rollback in `src/modules/reservation/reservation.service.spec.ts` — locked A available=8, B available=1, dto `{A:3, B:2}` where B insufficient, expects single `ConflictException` and no `Reservation` persisted

### Implementation for User Story 1

- [ ] T011 [US1] Add import `In` to `src/modules/reservation/reservation.service.ts:10` — change `import { DataSource, EntityManager } from 'typeorm'` to `import { DataSource, EntityManager, In } from 'typeorm'`; verify no duplicate import
- [ ] T012 [US1] Replace Inventory existence check with sorted `FOR UPDATE` lock in `src/modules/reservation/reservation.service.ts:79-87` — **DELETE** the loop `for (const item of dto.items) { const inv = await inventoryRepo.findOne(...) }`; **REPLACE** with:
  ```
  const sortedIds = [...new Set(dto.items.map((i) => i.inventoryId))].sort();
  const lockedInventories = await manager.find(Inventory, {
    where: { id: In(sortedIds) },
    lock: { mode: 'pessimistic_write' },
  });
  if (lockedInventories.length !== sortedIds.length) {
    const foundIds = new Set(lockedInventories.map((r) => r.id));
    const missing = sortedIds.find((id) => !foundIds.has(id))!;
    throw new NotFoundException(`Inventory ${missing} not found`);
  }
  const inventoryMap = new Map(lockedInventories.map((inv) => [inv.id, inv]));
  ```
  This satisfies FR-002/FR-003/FR-005: every requested row locked FOR UPDATE, deterministic ordering, only requested rows locked, inside same EntityManager. Keep the earlier `orderId` FK check and `seen` duplicate check above this block.
- [ ] T013 [US1] Add per-item availability check on locked rows in `src/modules/reservation/reservation.service.ts` — immediately after the `inventoryMap` line, add:
  ```
  for (const item of dto.items) {
    const inv = inventoryMap.get(item.inventoryId)!;
    if (inv.available < item.quantity) {
      throw new ConflictException(
        `Insufficient available inventory for ${item.inventoryId}. Available: ${inv.available}, requested: ${item.quantity}`,
      );
    }
  }
  ```
  This is FR-004 on the locked row's derived `available`. Use `inv.available` getter (data-model.md §1.1), never client value.
- [ ] T014 [US1] Increment `reservedAmount` via transactional EntityManager in `src/modules/reservation/reservation.service.ts` — immediately after the check loop, add:
  ```
  const inventoryRepo2 = manager.getRepository(Inventory);
  for (const item of dto.items) {
    const inv = inventoryMap.get(item.inventoryId)!;
    inv.reservedAmount += item.quantity;
    await inventoryRepo2.save(inv);
  }
  ```
  This is FR-007 via locked entity save so `CHECK reservedAmount <= stock` is enforced. Do NOT use global `this.inventoryRepo` here. Keep transaction short: no Redis/RabbitMQ/BullMQ/email between lock and save. Then keep the existing `reservationRepo.create/save` + `itemRepo.save` + `findByIdInternal` return.
- [ ] T015 [US1] Remove the now-dead `inventoryRepo` variable if unused in `src/modules/reservation/reservation.service.ts` — after T012, the old `const inventoryRepo = manager.getRepository(Inventory)` for findOne is gone; ensure no leftover reference; file must still compile
- [ ] T016 [US1] Run `npm run build` and `npm run lint` in `D:\Projects\mini-e-commerce` — fix any TypeScript/ESLint errors; build must be green before testing

**Checkpoint**: US1 should be fully functional; run `npx jest src/modules/reservation/reservation.service.spec.ts --runInBand` — T008-T010 must now pass; also manually verify via `POST /reservations` (quickstart.md §4.2-4.3) that within-available succeeds with `reservedAmount` increment and exceeding-available returns `409` with zero side effect.

---

## Phase 4: User Story 2 — Concurrent reservations do not oversell (Priority: P1)

**Goal**: Two concurrent `POST /reservations` for the last `available` units yield exactly one `201` + one `409`, final `reservedAmount` correct, no deadlock on opposite-order payloads. Proves FR-003 deterministic ordering and FR-002 row-level (not table-level) locking.

**Independent Test**: Concurrency integration test `stock=10,reserved=8 available=2`, two parallel `dataSource.transaction(manager => service.create(...))` each `qty=2` → one success, one `ConflictException`, final `reservedAmount=10` (not 12). Overlapping `{A,B}` vs `{B,A}` → no deadlock.

### Tests for User Story 2 (write FIRST, fail before implementation — but implementation is mostly US1's ordering; these tests verify it)

- [ ] T017 [P] [US2] Add concurrency integration test for contested last unit in `src/modules/reservation/test/reservation.integration.spec.ts` — new `describe('concurrency: contested last available')` with helper to set `UPDATE "Inventory" SET stock=10, "reservedAmount"=8 WHERE id='<id>'`, then:
  ```
  const dtoA:any={items:[{inventoryId:invId,quantity:2}]}, dtoB:any={items:[{inventoryId:invId,quantity:2}]};
  const results = await Promise.allSettled([
    dataSource.transaction(m=> reservationService.create(m, userA, dtoA)),
    dataSource.transaction(m=> reservationService.create(m, userB, dtoB)),
  ]);
  const successes = results.filter(r=>r.status==='fulfilled'), failures = results.filter(r=>r.status==='rejected');
  expect(successes).toHaveLength(1); expect(failures).toHaveLength(1);
  expect((failures[0] as any).reason).toBeInstanceOf(ConflictException);
  const inv = await inventoryRepo.findOne({where:{id:invId}}); expect(inv.reservedAmount).toBe(10); expect(inv.available).toBe(0);
  const count = await reservationRepo.count(); // only one reservation for this inv among those two
  ```
  Must run against real PostgreSQL (constitution VII); do NOT mock DataSource. This test MUST fail or be skipped before T012 ordering is correct.
- [ ] T018 [P] [US2] Add overlapping-order deadlock-avoidance test in `src/modules/reservation/test/reservation.integration.spec.ts` — inside same `describe`, create two inventories A2,B2 with stock=10,reserved=0, then:
  ```
  const dtoA:any={items:[{inventoryId:A2,quantity:1},{inventoryId:B2,quantity:1}]}; // A then B
  const dtoB:any={items:[{inventoryId:B2,quantity:1},{inventoryId:A2,quantity:1}]}; // B then A
  const results = await Promise.allSettled([
    dataSource.transaction(m=> reservationService.create(m, userA, dtoA)),
    dataSource.transaction(m=> reservationService.create(m, userB, dtoB)),
  ]);
  // no deadlock error: each result is either fulfilled or ConflictException due to availability, never QueryFailedError deadlock
  expect(results.every(r=> r.status==='fulfilled' || (r as any).reason instanceof ConflictException)).toBe(true);
  // verify both completed without deadlock/timeout
  ```
- [ ] T019 [P] [US2] Add disjoint-inventory parallel success test in `src/modules/reservation/test/reservation.integration.spec.ts` — two inventories X,Y disjoint, two concurrent reservations each for one inventory `available>>qty`, expects both `fulfilled`, both `reservedAmount` incremented by 1, proves row-level not table-level lock

### Implementation for User Story 2

- [ ] T020 [US2] Verify deterministic ordering is implemented in `src/modules/reservation/reservation.service.ts:79-87` — open the file, confirm `sortedIds = [...new Set(...)].sort()` and `manager.find(Inventory, { where:{id: In(sortedIds)}, lock:{mode:'pessimistic_write'} })` exists from T012; if not, fix it now; add a code comment `// deterministic lock ordering to prevent deadlocks (FR-003/D2)` above the line
- [ ] T021 [US2] Run concurrency suite in `D:\Projects\mini-e-commerce` — run `npx jest src/modules/reservation/test/reservation.integration.spec.ts --runInBand` (or `--testNamePattern=concurrency`); all three tests T017-T019 must pass; if deadlock or 500 occurs, re-check T012 ordering and that lock is inside the same `manager` transaction

**Checkpoint**: At this point, US1 AND US2 should both work independently — single-request correctness AND concurrent correctness proven against real PostgreSQL; no overselling in any execution.

---

## Phase 5: User Story 3 — Transaction rolls back on any failure (Priority: P2)

**Goal**: ANY failure inside `create` (past `expiresAt`, duplicate `inventoryId`, unknown `inventoryId`/`orderId`, insufficient `available`, DB CHECK violation) rolls back the whole transaction: no `Reservation` row, no `reservedAmount` change, no partial `ReservationItem`s. Guarantees SC-005 zero partial state.

**Independent Test**: Create with `{inventoryId:A, qty:1}` + `{unknown, qty:1}` → `404`, `A.reservedAmount` unchanged; duplicate `inventoryId` → `400`, unchanged; expired `expiresAt` → `400`, unchanged; `CHECK` violation → `409`, unchanged.

### Tests for User Story 3

- [ ] T022 [P] [US3] Add integration rollback test for unknown inventoryId in `src/modules/reservation/test/reservation.integration.spec.ts` — new `describe('rollback on failure')`: capture `before = (await inventoryRepo.findOne({where:{id:A}})).reservedAmount`, attempt `dataSource.transaction(m=> service.create(m, userId, {items:[{inventoryId:A,quantity:1},{inventoryId:'00000000-0000-0000-0000-000000000000',quantity:1}]}))` expects `NotFoundException`, then `after = (await inventoryRepo.findOne({where:{id:A}})).reservedAmount` must equal `before` and `reservationRepo.count({where:{userId}})` unchanged
- [ ] T023 [P] [US3] Add rollback test for duplicate inventoryId in `src/modules/reservation/test/reservation.integration.spec.ts` — same pattern, dto with same `inventoryId` twice, expects `BadRequestException("Duplicate inventoryId")`, `reservedAmount` unchanged, no reservation count increase
- [ ] T024 [P] [US3] Add rollback test for insufficient available in `src/modules/reservation/test/reservation.integration.spec.ts` — set `UPDATE "Inventory" SET stock=5, "reservedAmount"=4 WHERE id=A` (available=1), attempt qty=2, expects `ConflictException`, `reservedAmount` still 4, count unchanged
- [ ] T025 [P] [US3] Add unit test for `expiresAt` past rolls back in `src/modules/reservation/reservation.service.spec.ts` — mock manager, dto `expiresAt: new Date(Date.now()-1000).toISOString()`, expects `BadRequestException` and `manager.find` (lock) never called and `manager.save` never called

### Implementation for User Story 3

- [ ] T026 [US3] Verify all failure paths throw BEFORE or INSIDE the same transaction so `dataSource.transaction` rolls back in `src/modules/reservation/reservation.service.ts:46-90` — confirm: (a) `expiresAt` past → `BadRequestException` before lock, (b) duplicate `inventoryId` → `BadRequestException` before lock, (c) missing inventory after lock → `NotFoundException`, (d) `available < requested` → `ConflictException` after lock but before any `save`, (e) no `try/catch` that swallows and returns plain object; all exceptions are Nest HTTP exceptions serialized by `AllExceptionsFilter` (never 500 leakage)
- [ ] T027 [US3] Verify `complete`/`cancel`/`expire` remain status-only (no inventory mutation) in `src/modules/reservation/reservation.service.ts:183-224` — open the file, ensure no `reservedAmount`/`stock` change in those methods; they are out of scope for Phase 3 (FR-009/A10); if any such code exists, remove it — Phase 4 will add it
- [ ] T028 [US3] Run full rollback suite in `D:\Projects\mini-e-commerce` — run `npx jest src/modules/reservation/test/reservation.integration.spec.ts --runInBand --testNamePattern="rollback"` and `npx jest src/modules/reservation/reservation.service.spec.ts --runInBand`; all must pass with zero partial state

**Checkpoint**: All user stories now independently functional and failure-safe; SC-005 (100% of creation failures leave zero partial state) verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cross-cutting verification, docs, and cheap-model safety nets.

- [ ] T029 [P] Verify no external I/O inside reservation transaction in `src/modules/reservation/reservation.service.ts` — search the file for `cacheManager`, `CACHE_MANAGER`, `amqp`, `RabbitMQ`, `BullMQ`, `Queue`, `fetch`, `axios`, `http` inside `create()`; if any found between the `manager.find(Inventory` line and the final `return`, remove it — research D7 / FR-005 requires lock→check→increment→insert only
- [ ] T030 [P] Verify controller still thin and transaction-wrapping in `src/modules/reservation/reservation.controller.ts` — file must remain exactly `return this.reservationService.dataSource.transaction((manager) => this.reservationService.create(manager, userId, dto))` for `POST /reservations`; no business logic, no direct DB access, uses `@Auth(UserRoles.User, UserRoles.Admin)` + `@CurrentUser('sub')` + global `ValidationPipe`
- [ ] T031 Run full verification suite in `D:\Projects\mini-e-commerce` — run `npm run lint`, `npm run build`, `npm run test -- --runInBand`, and `npm run test:e2e -- --runInBand` (or at least `npx jest src/modules/reservation --runInBand`); all must be green; if `lint` fails on `reservation.service.ts`, fix import order and add `Logger` debug if missing
- [ ] T032 [P] Manual quickstart validation per `specs/003-transaction-safe-reservation/quickstart.md:4` in `D:\Projects\mini-e-commerce` — start app with `npm run start:dev`, run curls from quickstart §4.2-4.6 (happy-path `201`, exceed `409`, duplicate `400`, past `expiresAt` `400`, unknown `404`, concurrent `qty=2 vs qty=2` → one `201` one `409` reserved=10, opposite-order no deadlock), and psql checks `SELECT stock, "reservedAmount", stock-"reservedAmount" FROM "Inventory"`; document results
- [ ] T033 [P] Update documentation in `docs/plan.md` — mark Phase 3 as `DONE — 2026-08-30` with exit criterion `Concurrent reservation requests cannot oversell inventory — verified by integration concurrency test stock=10,reserved=8 qty=2 vs qty=2` and reference this feature directory `specs/003-transaction-safe-reservation`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (Phase 1) — **BLOCKS** all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - US1 (Phase 3) can start after Foundational — no dependencies on other stories, delivers MVP
  - US2 (Phase 4) depends on US1 implementation (deterministic ordering lives in US1); can be verified in parallel once US1 code is in place
  - US3 (Phase 5) depends on US1/US2 — rollback correctness builds on the same transaction
  - Stories can proceed sequentially (P1→P1→P2) or US2/US3 tests can be written in parallel with US1 once T007 is done
- **Polish (Phase 6)**: Depends on US1+US2+US3 complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — no dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) — implementation is US1's ordering, but tests are independent; should be tested after US1 code lands
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) — rollback tests independent, but implementation shares US1 transaction

### Within Each User Story

- Tests MUST be written and FAIL before implementation (cheap-model TDD guard)
- Imports before locking before availability check before increment before insert
- Story complete and `npm run build` green before moving to next priority

### Parallel Opportunities

- T004, T005, T006, T007 in Foundational phase can run in parallel (different files, no dependencies)
- T008, T009, T010 (US1 unit tests) can run in parallel (same file but different `it` blocks — safe to draft in parallel)
- T017, T018, T019 (US2 integration tests) can run in parallel (different describes)
- T022, T023, T024, T025 (US3 rollback tests) can run in parallel
- T029, T030, T032, T033 in Polish phase can run in parallel (different files)
- Tasks T011-T015 must run sequentially within US1 (same file, ordered edits)

---

## Parallel Example: User Story 1 (Atomic creation) 🎯 MVP

```bash
# Phase 1 + 2 foundation first (cheap model reads precedent):
# Task T004: read products.service.ts:updateMany pessimistic_write pattern
# Task T005: read reservation.service.ts current create()
# Once foundation done, US1 tests can be drafted in parallel:

# Draft three unit tests in parallel (different it blocks, same file):
Task T008: "Add unit test for happy-path atomic increment in reservation.service.spec.ts"
Task T009: "Add unit test for insufficient available rejection in reservation.service.spec.ts"
Task T010: "Add unit test for multi-item partial failure rollback in reservation.service.spec.ts"

# Then sequential implementation (same file, so not parallel):
Task T011: "Add import In to reservation.service.ts"
Task T012: "Replace Inventory existence check with sorted FOR UPDATE lock in reservation.service.ts"
Task T013: "Add per-item availability check on locked rows in reservation.service.ts"
Task T014: "Increment reservedAmount via transactional EntityManager in reservation.service.ts"

# Verify MVP:
npx jest src/modules/reservation/reservation.service.spec.ts --runInBand
npm run build && npm run lint
```

## Parallel Example: User Story 2 (Concurrency) 🎯 Must be P1

```bash
# After US1 code is in place, draft concurrency tests in parallel:
Task T017: "Add concurrency integration test for contested last unit in reservation.integration.spec.ts"
Task T018: "Add overlapping-order deadlock-avoidance test in reservation.integration.spec.ts"
Task T019: "Add disjoint-inventory parallel success test in reservation.integration.spec.ts"

# Then verify (no code change if T012 ordering correct):
Task T020: "Verify deterministic ordering is implemented in reservation.service.ts"
Task T021: "Run concurrency suite --runInBand (real PostgreSQL)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003) — verify branch, docker, no-migration
2. Complete Phase 2: Foundational (T004-T007) — **CRITICAL**: read precedent, current service, controller, entity
3. Complete Phase 3: User Story 1 (T008-T016) — tests first (must fail), then T011-T015 sequential edits, then build/lint
4. **STOP and VALIDATE**: `npx jest src/modules/reservation/reservation.service.spec.ts --runInBand` must be green, `npm run build` green, manual curl `POST /reservations` within-available `201` + exceed `409` with zero partial state
5. Deploy/demo if ready — MVP is the atomic reservation primitive (SC-001 + SC-002)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → Test independently → `build`/`lint` green → MVP! (`reservedAmount` correctness on single request)
3. Add US2 → Test independently against real PostgreSQL → `stock=10,reserved=8 qty=2 vs qty=2` → one `201` one `409`, no deadlock (SC-003 + SC-004)
4. Add US3 → Test independently → 100% failure cases leave zero partial state (SC-005)
5. Polish → `test:e2e`, `quickstart.md` curls, `docs/plan.md` mark DONE
6. Each story adds value without breaking previous stories; US2/US3 reuse US1 transaction

### Parallel Team Strategy

With multiple developers (or cheap model + reviewer):
1. Team completes Setup + Foundational together (T001-T007)
2. Once Foundational is done:
   - Developer A: User Story 1 (T008-T016)
   - Developer B: drafts US2 tests (T017-T019) in parallel (different file sections)
   - Developer C: drafts US3 tests (T022-T025) in parallel
3. Once US1 lands, Developer B runs T020-T021 (concurrency suite), Developer C runs T026-T028 (rollback suite)
4. All stories integrate via the single transactional `create()` path

---

## Notes

- **[P] tasks** = different files or different `describe`/`it` blocks with no dependency on incomplete tasks
- **[Story] label** maps task to specific user story for traceability (`[US1]` → atomic creation, `[US2]` → concurrency, `[US3]` → rollback)
- Each user story is independently testable — see **Independent Test** per phase
- **Cheap-model tips**:
  - Do NOT invent a new migration, entity, or module for Phase 3 — only edit `reservation.service.ts`
  - Do NOT touch `inventory.service.ts` `reserve()` (global repo) inside the transaction — use `manager.getRepository(Inventory)` and `manager.find` with lock
  - Do NOT use `manager.increment` with a separate query — save the locked entity so `available` getter stays consistent
  - Keep the `Controller` unchanged — it already wraps in `dataSource.transaction`
  - Keep `synchronize: false` — do not add `synchronize:true` to pass tests
  - Verify by running `npm run build` after every file edit, not at the end
  - Commit after each task or logical group (`git add -A && git commit -m "feat(reservation): T0XX ... [spec 003]"`)
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same-file parallel conflicts, cross-story dependencies that break independence

