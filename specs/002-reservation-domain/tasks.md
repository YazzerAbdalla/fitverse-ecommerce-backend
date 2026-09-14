# Tasks: Reservation Domain (Phase 2)

**Input**: Design documents from `/specs/002-reservation-domain/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/reservation-api.md, quickstart.md
**Branch**: `002-reservation-domain`

**Tests**: REQUIRED — spec FR-011 mandates unit tests (service) and integration tests (real PostgreSQL). Test tasks are included below.

**Organization**: Tasks are grouped by user story. Story mapping:
- US1 — Create reservation with items (P1, MVP)
- US2 — Retrieve reservation (P1)
- US3 — Validate state transitions (P2)
- US4 — List / ownership scoping (P3)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to (US1-US4). Setup/Foundational/Polish have no story label.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create module structure and register entities so the rest can compile.

- [X] T001 [P] Create `src/modules/reservation/` directory tree with subfolders `entities/`, `dto/`, `test/` per plan.md §1
- [X] T002 [P] Register `Reservation` and `ReservationItem` in the `entities` array of `src/data-source.ts` per plan.md §7.2 (import from `./modules/reservation/entities/...`)
- [X] T003 Start required infrastructure with `docker-compose up -d` (postgres) per quickstart.md prerequisites

**Checkpoint**: Directory skeleton and entity registration present; app still compiles after entities are added in Phase 2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core domain types, DTOs, module wiring, and migration that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Create `ReservationStatus` enum (`RESERVED|COMPLETED|EXPIRED|CANCELLED`) in `src/modules/reservation/entities/reservation-status.enum.ts` per plan.md §2.1
- [X] T005 [P] Create `Reservation` entity in `src/modules/reservation/entities/reservation.entity.ts` with `@Index(['userId'])`, `@Index(['status'])`, `@Index(['expiresAt'])`, `@Index(['status','expiresAt'])`, FKs to User/Order, `items` OneToMany per plan.md §2.2
- [X] T006 [P] Create `ReservationItem` entity in `src/modules/reservation/entities/reservation-item.entity.ts` with `@Unique(['reservationId','inventoryId'])`, `@Check('"quantity" > 0')`, FKs to Reservation/Inventory per plan.md §2.3
- [X] T007 [P] Create DTOs in `src/modules/reservation/dto/`: `create-reservation.dto.ts` (items array, optional expiresAt/orderId, nested item validators), `reservation-response.dto.ts`, `update-reservation-status.dto.ts` per plan.md §3
- [X] T008 [P] Create migration `src/migration/<TIMESTAMP>-CreateReservationAndReservationItem.ts` with full `up()`/`down()` (enum, tables, indexes, unique, `CHECK quantity > 0`, FKs, CASCADE/SET NULL) per plan.md §8
- [X] T009 Implement `ReservationModule` in `src/modules/reservation/reservation.module.ts` (imports `TypeOrmModule.forFeature([Reservation, ReservationItem])`, `UsersModule`/`InventoryModule`/`OrderModule`, exports `ReservationService`) and import it into `src/app.module.ts` per plan.md §6 and §7.1
- [X] T010 [P] Create `ReservationService` skeleton in `src/modules/reservation/reservation.service.ts`: `@Injectable()`, `@InjectDataSource() private dataSource`, `Logger`, public `validateTransition(from,to)` (throws `ConflictException` per ALLOWED_TRANSITIONS map), private `assertOwner(reservation, requestingUserId, role?)` (throws `ForbiddenException`), private `findByIdInternal(manager, id)` (throws `NotFoundException`) per plan.md §4.1
- [X] T011 [P] Create `ReservationController` skeleton in `src/modules/reservation/reservation.controller.ts`: `@Controller('reservations')`, class-level `@Auth(UserRoles.User, UserRoles.Admin)`, import `Auth` from `../auth/decorators/auth.decorator` and `CurrentUser` from `../auth/decorators/current-user.decorator` (matching `cart.controller.ts`), inject `ReservationService` per plan.md §5

**Checkpoint**: App compiles; `Reservation`/`ReservationItem` tables creatable via migration; service/controller skeletons present. User stories can now be implemented.

---

## Phase 3: User Story 1 — Create reservation with items (Priority: P1) 🎯 MVP

**Goal**: Authenticated user creates a reservation claiming 1..N inventories; persisted with status RESERVED, default `expiresAt = now+15m`, correct items/FKs.

**Independent Test**: `POST /reservations` with valid items for existing inventories returns 201 with status RESERVED and items; invalid cases return 400/404.

### Tests for User Story 1

> Write these tests FIRST, ensure they FAIL before implementation.

- [X] T012 [P] [US1] Unit test `create` in `src/modules/reservation/reservation.service.spec.ts`: default expiresAt = now+15m; rejects past `expiresAt` (400); rejects duplicate `inventoryId` (400); rejects unknown `inventoryId` (404); rejects unknown `orderId` (404); returns RESERVED with items
- [X] T013 [P] [US1] Integration test create in `src/modules/reservation/test/reservation.integration.spec.ts`: insert Inventory row, create reservation via `dataSource.transaction(m => service.create(m, userId, dto))`, assert DB `Reservation`+`ReservationItem` rows; assert `quantity=0` INSERT violates `CHECK` (catch error)

### Implementation for User Story 1

- [X] T014 [US1] Implement `create(manager: EntityManager, requestingUserId: string, dto: CreateReservationDto)` in `src/modules/reservation/reservation.service.ts`: compute expiresAt (default 15m / future check), validate orderId existence → 404, detect duplicate inventoryId → 400, validate each inventoryId exists → 404, persist Reservation + items via `manager.getRepository` per plan.md §4
- [X] T015 [US1] Implement `POST /reservations` route in `src/modules/reservation/reservation.controller.ts`: `@Post()`, `@CurrentUser('sub')` userId, `@Body() dto`, wrap `service.dataSource.transaction(m => service.create(m, userId, dto))`, return `Reservation` entity (with items) per plan.md §5 and contracts/reservation-api.md §1

**Checkpoint**: A reservation with items can be created and read back with status RESERVED (MVP demonstrable).

---

## Phase 4: User Story 2 — Retrieve reservation (Priority: P1)

**Goal**: Owner or ADMIN fetches a reservation by id with its items; others get 401/403; unknown id 404.

**Independent Test**: `GET /reservations/:id` returns reservation+items for owner; 403 for non-owner non-admin; 404 for unknown id.

### Tests for User Story 2

- [X] T016 [P] [US2] Unit test `findById` in `src/modules/reservation/reservation.service.spec.ts`: owner returns reservation; non-owner non-admin → 403; unknown id → 404
- [X] T017 [P] [US2] Integration test GET by id in `src/modules/reservation/test/reservation.integration.spec.ts`: create then fetch, assert items present

### Implementation for User Story 2

- [X] T018 [US2] Implement `findById(requestingUserId: string, id: string, role?: UserRoles)` in `src/modules/reservation/reservation.service.ts`: read with `relations:['items']`, call `assertOwner`, throw 404 if missing per plan.md §4
- [X] T019 [US2] Implement `GET /reservations/:id` route in `src/modules/reservation/reservation.controller.ts`: `@Get(':id')`, `@CurrentUser('sub')` + `@CurrentUser('role')`, call `service.findById`, return `Reservation` entity per contracts/reservation-api.md §2

**Checkpoint**: Reservations retrievable by owner/admin only; US1 and US2 both independently functional.

---

## Phase 5: User Story 3 — Validate state transitions (Priority: P2)

**Goal**: Enforce 4-state machine; only `RESERVED → COMPLETED|EXPIRED|CANCELLED` allowed; others 409.

**Independent Test**: Transition `RESERVED → COMPLETED` succeeds; `COMPLETED → CANCELLED` → 409; `orderId` set on complete if valid.

### Tests for User Story 3

- [X] T020 [P] [US3] Unit test transition matrix in `src/modules/reservation/reservation.service.spec.ts`: RESERVED→COMPLETED/CANCELLED/EXPIRED succeed; COMPLETED/EXPIRED/CANCELLED → any transition throws 409; `complete` with valid orderId sets it, invalid orderId → 404
- [X] T021 [P] [US3] Integration test transition persistence in `src/modules/reservation/test/reservation.integration.spec.ts`: complete then assert status COMPLETED in DB; second cancel → 409

### Implementation for User Story 3

- [X] T022 [US3] Implement `complete`, `cancel`, `expire`, and private `transition(manager, requestingUserId, id, to, orderId?, role?)` in `src/modules/reservation/reservation.service.ts`: load, `assertOwner`, `validateTransition`, set orderId (404 if invalid), update status per plan.md §4
- [X] T023 [US3] Implement routes `PATCH /reservations/:id/complete`, `PATCH /reservations/:id/cancel`, `PATCH /reservations/:id/expire` in `src/modules/reservation/reservation.controller.ts`: wrap writes in `dataSource.transaction`, add `@Auth(UserRoles.Admin)` on the `expire` route, return `Reservation` entity per contracts/reservation-api.md §4-6

**Checkpoint**: State machine enforced everywhere; invalid transitions rejected with 409.

---

## Phase 6: User Story 4 — List / ownership scoping (Priority: P3)

**Goal**: User lists own reservations (paginated); ADMIN may list all or filter by userId.

**Independent Test**: User with 3 reservations listing `page=1&limit=2` returns 2 + meta; admin `?userId=` filters.

### Tests for User Story 4

- [X] T024 [P] [US4] Unit test `listByUser` in `src/modules/reservation/reservation.service.spec.ts`: non-admin returns only own reservations; admin with `userId` filter returns that user's; pagination meta correct
- [X] T025 [P] [US4] Integration test list pagination in `src/modules/reservation/test/reservation.integration.spec.ts`: seed 3 for U + 1 for V, assert scoping

### Implementation for User Story 4

- [X] T026 [US4] Implement `listByUser(requestingUserId, pagination, filter?, role?)` in `src/modules/reservation/reservation.service.ts`: build `where` (own id unless ADMIN+filter), `findAndCount` with `skip/take`, return `{ data, meta }` matching existing pagination shape per plan.md §4
- [X] T027 [US4] Implement `GET /reservations` route in `src/modules/reservation/reservation.controller.ts`: `@Get()`, `@Query('page')`/`@Query('limit')`/`@Query('userId')`, call `service.listByUser` per contracts/reservation-api.md §3

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Verify against real DB, docs, and quality gates.

- [X] T028 Run integration suite against real PostgreSQL: `docker-compose up -d` then `npm run test -- reservation.integration.spec` per quickstart.md (assert `CHECK quantity > 0`, unique `(reservationId, inventoryId)`, FKs, enum)
- [X] T029 [P] Update `AGENTS.md` Module map to add a `reservation` row (`ReservationModule`, REST, state machine) pointing to `src/modules/reservation` per plan.md §1
- [X] T030 Write an ADR in `docs/decisions/` recording the EntityManager Option B decision (service write methods require `EntityManager` now) and update `docs/plan.md` after the phase per AGENTS.md §8 (constitution IX / C2)
- [X] T031 Run `npm run migration:run`, `npm run lint`, `npm run build`, `npm run test` and execute the quickstart.md manual API flow (create → get → list → complete → cancel 409 → validation 400s); also verify SC-005 module-boundary rule — no `@InjectRepository(Reservation|ReservationItem)` outside `reservation` module (C1) — to confirm Phase 2 exit criteria (plan.md §12)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately (T001, T002 parallel; T003 infra).
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories. T004-T007 parallel; T009 depends on T004-T006; T010/T011 parallel (skeletons).
- **User Stories (Phase 3-6)**: All depend on Foundational. Implement in priority order P1 → P2 → P3 (or parallel if staffed). Within a story: tests first (T012/T013, etc.), then service method, then controller route.
- **Polish (Phase 7)**: Depends on all user stories complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational. No story dependencies.
- **US2 (P1)**: After Foundational. Independent of US1 (different service method/route), can run parallel with US1 if staffed.
- **US3 (P2)**: After Foundational. Independent; uses `transition` helper.
- **US4 (P3)**: After Foundational. Independent; uses pagination shape.

### Within Each User Story

- Tests MUST be written and FAIL before implementation.
- Entities/DTOs already exist (Foundational) — stories add service methods + routes.
- Service method before its controller route.
- Story complete (tests green) before next priority.

### Parallel Opportunities

- All Setup tasks marked [P] (T001, T002) can run in parallel.
- All Foundational entity/DTO/migration/skeleton tasks marked [P] (T004-T008, T010, T011) can run in parallel.
- Once Foundational completes, US1/US2/US3/US4 can be worked in parallel by different developers.
- All unit tests for a story marked [P] can run in parallel; all integration checks aggregate in T028.

---

## Parallel Example: User Story 1

```bash
# Launch tests for US1 together:
Task T012: "Unit test create in src/modules/reservation/reservation.service.spec.ts"
Task T013: "Integration test create in src/modules/reservation/test/reservation.integration.spec.ts"

# Launch foundational entities in parallel (different files):
Task T004: "ReservationStatus enum in src/modules/reservation/entities/reservation-status.enum.ts"
Task T005: "Reservation entity in src/modules/reservation/entities/reservation.entity.ts"
Task T006: "ReservationItem entity in src/modules/reservation/entities/reservation-item.entity.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 (create + retrieve pair recommended since retrieve is needed to verify create)
4. **STOP and VALIDATE**: `POST /reservations` then `GET /reservations/:id` works against real DB
5. Demo if ready

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 + US2 → test independently → MVP (create + read)
3. US3 → test independently → state machine enforced
4. US4 → test independently → listing
5. Polish → integration + docs + quality gates

### Parallel Team Strategy

With multiple developers:
1. Team completes Setup + Foundational together
2. Once Foundational done: Developer A = US1+US2, Developer B = US3, Developer C = US4
3. Stories integrate independently; T028/T029/T030 finalize

---

## Format Validation

All tasks follow the strict checklist format:
- Start with `- [ ]`
- Sequential Task ID (T001 … T030)
- `[P]` marker only where parallelizable
- `[USx]` label on all user-story-phase tasks (T012-T027); absent on Setup/Foundational/Polish
- Every task names an exact file path

**Totals**: 30 tasks — Setup 3, Foundational 8, US1 4, US2 4, US3 4, US4 4, Polish 3.
**MVP scope**: Phase 1 + Phase 2 + Phase 3 (US1) + Phase 4 (US2 recommended for verification).
**Parallel opportunities**: Foundational entities/DTOs/migration/skeletons; user stories after foundation.
**Independent test criteria**: see each story's "Independent Test" above.

---

## Notes

- Do NOT implement inventory `reservedAmount` mutation, pessimistic locking, or expiration worker (Phases 3-5 per spec FR-010 / plan.md §12).
- All service write methods take `EntityManager` as first param; controller wraps in `dataSource.transaction` (clarification Option B).
- Unknown fields rejected by global `ValidationPipe` (whitelist + forbidNonWhitelisted).
- Commit after each task or logical group; stop at any checkpoint to validate the story independently.
