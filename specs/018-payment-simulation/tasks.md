# Tasks: Payment Simulation (Demo)

**Input**: Design documents from `/specs/018-payment-simulation/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/
**Branch**: `018-payment-simulation`

**Tests**: Included per constitution VII (unit + real-PG integration + concurrency + E2E) and spec SC-002/SC-003.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold payment module shell and migration placeholder (no business logic yet)

- [x] T001 Create payment module directory shell `src/modules/payment/` with placeholder `payment.module.ts`
- [x] T002 [P] Create `PaymentStatus` enum in `src/modules/payment/entities/payment-status.enum.ts`
- [x] T003 [P] Create `CreatePaymentIntentDto` in `src/modules/payment/dto/create-payment-intent.dto.ts`
- [x] T004 [P] Create `ConfirmPaymentDto` in `src/modules/payment/dto/confirm-payment.dto.ts` (result enum + fixed failureReason enum)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Persistence + module wiring that ALL stories depend on. No story work until complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create `Payment` entity in `src/modules/payment/entities/payment.entity.ts` (orderId UNIQUE FK CASCADE, userId, amount CHECK>=0, usd, status, simulation, failureReason, indexes per data-model.md)
- [x] T006 Create migration `src/migration/17XXXXXXXXXX-CreatePayment.ts` (up: create table + indexes + checks; down: drop; never edit committed migrations)
- [x] T007 Wire `PaymentModule` in `src/modules/payment/payment.module.ts` (forFeature([Payment]) + imports Order/Reservation/Inventory/Users via services, providers/exports PaymentService)
- [x] T008 Register `PaymentModule` in `src/app.module.ts` imports
- [x] T009 Add pending-payment expiry skip in `src/modules/reservation/reservation-expiration.service.ts` (skip candidates with PENDING payment per Q2/D5)

**Checkpoint**: Foundation ready — `npm run build` passes with empty service/controller stubs; story work can begin

---

## Phase 3: User Story 1 - Pay for my order successfully (Priority: P1) 🎯 MVP

**Goal**: Shopper starts a payment for own PENDING order and confirms success → Payment SUCCEEDED + Order COMPLETED + Reservation COMPLETED + single stock decrement.

**Independent Test**: Register → cart → checkout → `POST /payments/intent` 201 PENDING → `POST /payments/:id/confirm {success}` 200 → `GET /order/:id` COMPLETED + `GET /payments/:id` SUCCEEDED + inventory decremented once; re-confirm → 200 zero-delta.

### Tests for User Story 1

- [x] T010 [P] [US1] Unit tests for `createIntent` in `src/modules/payment/payment.service.spec.ts` (valid 201, duplicate PENDING idempotent, non-PENDING 409, non-owner 403, missing 404)
- [x] T011 [P] [US1] Unit tests for `confirm success` in `src/modules/payment/payment.service.spec.ts` (success path, terminal re-confirm 200 zero-delta, validation 400)
- [x] T012 [P] [US1] Real-PG concurrency test in `src/modules/payment/test/payment.confirm-concurrency.integration.spec.ts` (Promise.all confirm ×2 → one mutation, second idempotent)

### Implementation for User Story 1

- [x] T013 [US1] Implement `PaymentService.createIntent` in `src/modules/payment/payment.service.ts` (FOR UPDATE Order, assertOwner owner-only Q1, PENDING-only, 1:1 idempotent, amount=Order.total)
- [x] T014 [US1] Implement `PaymentService.confirmSuccess` path in `src/modules/payment/payment.service.ts` (single tx FOR UPDATE Payment→Order→Reservation→sorted Inventories, delegate to OrderCompletionService core per D1, mark SUCCEEDED)
- [x] T015 [US1] Implement `PaymentController` intent + confirm-success routes in `src/modules/payment/payment.controller.ts` (thin, @Auth() + RateLimitGuard shared checkout bucket Q3/D6 + ValidationPipe + Swagger + owner-only writes)
- [x] T016 [US1] E2E success flow in `test/payment.e2e-spec.ts` (checkout→intent→confirm→COMPLETED per quickstart.md)

**Checkpoint**: US1 fully functional and demoable independently (MVP!)

---

## Phase 4: User Story 2 - Handle declined card (Priority: P2)

**Goal**: Confirm with `declined` + fixed-enum reason → Payment FAILED + Order FAILED + Reservation CANCELLED + hold released, stock unchanged.

**Independent Test**: Checkout → intent → `confirm {declined, card_declined}` 200 → order FAILED + payment FAILED + reserved released; re-confirm → 200 zero-delta.

### Tests for User Story 2

- [x] T017 [P] [US2] Unit tests for `confirm declined` in `src/modules/payment/payment.service.spec.ts` (FAILED mapping, enum enforcement Q4/D7, invalid reason 400, terminal re-confirm 200)

### Implementation for User Story 2

- [x] T018 [US2] Implement `PaymentService.confirmDeclined` path in `src/modules/payment/payment.service.ts` (reuse OrderCancellationService reason=failed core per D2, mark FAILED + failureReason)
- [x] T019 [US2] Extend `PaymentController` confirm route in `src/modules/payment/payment.controller.ts` to accept declined branch (no new route; DTO enum already from T004)
- [x] T020 [US2] E2E decline flow in `test/payment.e2e-spec.ts` (checkout→intent→declined→FAILED + inventory released)

**Checkpoint**: US1 + US2 both work independently (success vs decline)

---

## Phase 5: User Story 3 - Cancel before paying (Priority: P2)

**Goal**: Cancel own PENDING payment → Payment CANCELLED + Order CANCELLED + Reservation CANCELLED + hold released.

**Independent Test**: Checkout → intent → `POST /payments/:id/cancel {}` 200 → all CANCELLED; cancel terminal → 409.

### Tests for User Story 3

- [x] T021 [P] [US3] Unit tests for `cancel` in `src/modules/payment/payment.service.spec.ts` (PENDING→CANCELLED, terminal 409, non-owner 403, missing 404)

### Implementation for User Story 3

- [x] T022 [US3] Implement `PaymentService.cancel` in `src/modules/payment/payment.service.ts` (single tx, reuse cancellation core reason=cancelled per D2)
- [x] T023 [US3] Add cancel route in `src/modules/payment/payment.controller.ts` (POST /payments/:id/cancel, owner-only, RateLimitGuard)

**Checkpoint**: Cancel path works without affecting US1/US2

---

## Phase 6: User Story 4 - View my payments (Priority: P3)

**Goal**: Owner fetch + paginated list (status-only filter Q5/D8); admin may read any + `?userId=`.

**Independent Test**: Create 2 payments → `GET /payments/:id` owner 200 / stranger 403 / admin 200 → `GET /payments?status=` paginated newest-first owner-scoped.

### Tests for User Story 4

- [x] T024 [P] [US4] Unit tests for `get/list` in `src/modules/payment/payment.service.spec.ts` (owner scope, admin bypass on reads, status filter, pagination defaults page=1 limit=20 max=100)

### Implementation for User Story 4

- [x] T025 [US4] Implement `PaymentService.getById/listByUser` in `src/modules/payment/payment.service.ts` (createdAt DESC, skip=(page-1)*limit, {data, meta})
- [x] T026 [US4] Add read routes in `src/modules/payment/payment.controller.ts` (GET /payments/:id + GET /payments, owner-or-Admin)

**Checkpoint**: All stories independently functional

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, contract parity, and verification gates (exit criteria §19.9)

- [x] T027 Write ADR `docs/decisions/ADR-payment-simulation.md` (1:1, reuse cores, owner-only, expiry-block, no outbox event, Stripe deferred)
- [x] T028 [P] Update `docs/manual-e2e-test-flow.md` payment section (intent→confirm success/decline curls per quickstart.md)
- [x] T029 [P] Swagger polish on `src/modules/payment/payment.controller.ts` + DTOs (`@ApiOperation/@ApiResponse`, 400/401/403/404/409/429)
- [x] T030 Run verification gates: `npm run lint`, `npm run build`, `npm run test -- --runInBand src/modules/payment`, E2E `test/payment.e2e-spec.ts`, quickstart validation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all stories
- **User Stories (Phase 3–6)**: Depend on Foundational; US1 first (MVP), then US2/US3/US4 sequentially or in parallel if staffed (US2–US4 touch the same `payment.service.ts`/`payment.controller.ts` — coordinate merges)
- **Polish (Phase 7)**: Depends on all desired stories complete

### User Story Dependencies

- **US1 (P1)**: After Foundational — no story dependencies (MVP)
- **US2 (P1/P2)**: After Foundational — extends US1 confirm branch, independently testable via decline path
- **US3 (P2)**: After Foundational — independent cancel path, shares service/controller files with US1/US2
- **US4 (P3)**: After Foundational — read-only, no dependency on confirm/cancel logic beyond the rows they create

### Within Each Story

- Tests FAIL before implementation (TDD where touched)
- Entity/migration → service → controller → integration/E2E
- One story validated before next (checkpoints above)

### Parallel Opportunities

- T002/T003/T004 (enum + DTOs) parallel
- T010/T011/T012 (US1 tests) parallel
- T013→T014→T015 sequential (same service/controller chain); T016 E2E after
- US2/US3/US4 can parallelize across developers after Foundational, with merge coordination on shared files
- T027/T028/T029 (docs/Swagger) parallel in Polish

---

## Parallel Example: User Story 1

```bash
# Launch US1 tests together:
Task: "Unit tests for createIntent in src/modules/payment/payment.service.spec.ts"
Task: "Unit tests for confirm success in src/modules/payment/payment.service.spec.ts"
Task: "Real-PG concurrency test in src/modules/payment/test/payment.confirm-concurrency.integration.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup + Phase 2: Foundational
2. Complete Phase 3: US1 (intent + confirm success + reads needed for verify)
3. **STOP and VALIDATE**: run quickstart success path + `npm run build` + targeted tests
4. Deploy/demo if ready (checkout→intent→confirm→COMPLETED clickable)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → MVP demo (success path)
3. US2 → decline path demo
4. US3 → cancel path demo
5. US4 → history/support reads
6. Polish → ADR + manual-e2e + Swagger + full gates

---

## Notes

- [P] = different files, no dependencies; [USx] maps task to story for traceability
- Lock order fixed everywhere: `Payment → Order → Reservation → sorted Inventories` (D3)
- Owner-only writes (Q1/D4); reads owner-or-Admin; amount server-copied; currency `usd`; provider `simulation`
- Expiry skips orders with PENDING payment (Q2/D5); throttle reuses checkout 10/h buckets (Q3/D6); decline enum fixed (Q4/D7); list status-only (Q5/D8)
- JSDoc per AGENTS.md §3 on every new class/method; no `any`; no cross-module repos
