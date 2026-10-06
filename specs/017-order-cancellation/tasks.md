# Tasks: Order Cancellation (Phase 8, demo scope)

**Input**: Design documents from `/specs/017-order-cancellation/`
**Prerequisites**: plan.md (required), spec.md, research.md, data-model.md, contracts/order-cancel.md, quickstart.md

**Tests**: Included — required by Success Criteria SC-001..SC-005 (zero silent
cancels, exactly-once inventory) and constitution VII (DB-backed consistency
proofs). Unit tests use mocked `EntityManager`; consistency/concurrency tests
use real PostgreSQL; E2E uses `supertest`.

**Organization**: Tasks grouped by user story; each story independently
testable. No schema change, no new routes in any phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline before touching the money path

- [ ] T001 Verify green baseline on `017-order-cancellation`: run `npm run build` and `npm run test -- --runInBand src/modules/order` and record results in `specs/017-order-cancellation/tasks.md` notes
- [ ] T002 [P] Pin current cancel contract with a characterization test in `src/modules/order/test/order-cancel.characterization.spec.ts` (real PG optional): assert current `POST /order/:id/cancel` returns `{id, status, total, userId}` and outbox swallow commits on record-write failure — documents the two intentional B-deltas this phase will change (D2 response shape, D2 rollback)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Test harness and fixtures every story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Create cancel test fixture helper in `src/modules/order/test/cancel-fixtures.ts` (checkout a PENDING order + RESERVED reservation via `OrderCheckoutService` on real PG; return `{orderId, reservationId, productIds, quantities}`)
- [ ] T004 [P] Fix `src/modules/order/order.controller.spec.ts` to provide a mocked `OrderCancellationService` (unblocks required-dependency wiring in US1)
- [ ] T005 Decide service return shape in `src/modules/order/order-cancellation.service.ts` docstring: `cancel()` returns enriched `{order, reservationId, reason}` (needed by FR-012; only caller is `OrderController.cancel`, expiry path untouched per D4)

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Cancel a pending order before sale (Priority: P1) 🎯 MVP

**Goal**: Shopper cancels own PENDING order → CANCELLED + hold released, stock
unchanged, single tx, idempotent re-cancel, 403/404/409 matrix.

**Independent Test**: Checkout → `POST /order/:id/cancel` → `200` enriched
shape → `GET /order/:id` CANCELLED → inventory `reservedAmount` released,
`stock` unchanged → re-cancel `200` zero delta.

### Tests for User Story 1 (write FIRST, ensure they FAIL before implementation)

- [ ] T006 [P] [US1] Unit matrix for `cancel()` in `src/modules/order/order-cancellation.service.spec.ts` (mocked `EntityManager`): PENDING→CANCELLED releases hold; re-cancel CANCELLED/FAILED idempotent 200; COMPLETED→409; non-owner→403; missing order→404; missing inventory→404; `FAILED` target on `reason=failed` with reservation→CANCELLED (D3)
- [ ] T007 [P] [US1] Real-PG integration in `src/modules/order/test/order-cancel.integration.spec.ts`: atomic cancel (order+reservation+inventory+outbox all move or none); forced outbox INSERT failure rolls back the whole cancel (D2/Q2-A regression); reservation already-terminal closes order with zero inventory delta; `available = stock - reservedAmount` restored
- [ ] T008 [P] [US1] Concurrency proof in `src/modules/order/test/order-cancel.concurrency.spec.ts` (real PG, `Promise.all`): `cancel vs cancel` single release; `cancel vs complete` exactly one winner with consistent final state (SC-004)

### Implementation for User Story 1

- [ ] T009 [US1] Harden `cancel()` in `src/modules/order/order-cancellation.service.ts` (depends on T005): delete outbox try/catch-warn so record failure propagates/rolls back (D2); implement failed-path disposition order→FAILED + reservation→CANCELLED + release (D3); type lock options (remove `as any`); keep `FOR UPDATE` Order → Reservation → sorted Inventories (D5); full JSDoc + `//` intent comments per AGENTS.md §3
- [ ] T010 [US1] Wire required dependency + enriched response in `src/modules/order/order.controller.ts`: remove `@Optional()`/`!`/not-available branch for `OrderCancellationService` (D7/OD-1); return `{id, status, total, userId, reason, reservationId}` per `specs/017-order-cancellation/contracts/order-cancel.md` (D6, keys existing byte-identical)
- [ ] T011 [US1] Update characterization test from T002 to the new contract in `src/modules/order/test/order-cancel.characterization.spec.ts`: enriched shape asserted, swallow-behavior test inverted to rollback-behavior test
- [ ] T012 [US1] Run quickstart flow in `specs/017-order-cancellation/quickstart.md` steps 1–6 against local dev and record output (SC-001/SC-002 evidence)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Admin and system-driven cancellation (Priority: P2)

**Goal**: Admin cancels another user's PENDING order; expiry auto-cancel path
proven unchanged and race-safe against user cancel.

**Independent Test**: Admin cancels shopper's order → CANCELLED + released;
force reservation expiry → order CANCELLED + reservation EXPIRED with a
single release even when user-cancel races expiry.

### Tests for User Story 2

- [ ] T013 [P] [US2] Admin-cancel + ownership matrix in `src/modules/order/test/order-cancel.integration.spec.ts` (extend): admin cancels other's order 200; non-owner non-admin 403; unauthenticated 401
- [ ] T014 [P] [US2] Expiry regression + race in `src/modules/reservation/test/order-cancel-expiry.race.spec.ts` (real PG): expired reservation auto-cancels order with `order.cancelled(reason=expired)` row present; `Promise.all([userCancel, expireOne])` yields exactly one inventory release and a consistent terminal pair (no double-release)

### Implementation for User Story 2

- [ ] T015 [US2] Verify no code change needed in `src/modules/reservation/reservation-expiration.service.ts` (D4 — read-only task): confirm `reason=expired` envelope matches `specs/017-order-cancellation/data-model.md` and record confirmation in `specs/017-order-cancellation/tasks.md` notes; if mismatch found, align envelope fields only, touching no lock/poison logic

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Cancellation is observable (Priority: P3)

**Goal**: Every committed cancel has a matching `order.cancelled` record with
order id, previous/new status, reason, reservation link (SC-005); reason
visible without extra lookups where already available.

**Independent Test**: Cancel for each reason → query `outbox_event` by order
id → exactly one `order.cancelled` row with the documented envelope; cancel
response carries reason + reservation link.

### Tests for User Story 3

- [ ] T016 [P] [US3] Outbox-envelope assertions in `src/modules/order/test/order-cancel.integration.spec.ts` (extend): `payload.eventId === row.id`, `version: 1`, `previousStatus: PENDING`, `newStatus` matches, `reason ∈ {user, expired, failed}`, `reservationId` matches (or null); duplicate cancel emits no second row

### Implementation for User Story 3

- [ ] T017 [US3] Record GET-visibility deferral in `specs/017-order-cancellation/research.md` (append D9): order reads (`GET /order`, `GET /order/:id`) do NOT embed the reason (no migration per no-DDL constraint); reason is observable via cancel response (FR-012) + `order.cancelled` record; embedding into reads is a post-demo follow-up

**Checkpoint**: All user stories should now be independently functional

---

## Phase 6: Senior Review Hardening (SOLID/DRY)

**Purpose**: Fix review findings that Phase 8 touches or that block its exit
bar; record the rest as deferred with an owner. Full report: review table in
chat 2026-10-06 (20 findings, F1–F4/M1–M16). Executes interleaved with Phases
3–5 (same files, same PRs); numbered after for ID stability.

### A. In-scope fixes (new tasks)

- [ ] T023 [US1] Unify order transition authority in `src/modules/order/order-transitions.ts` (NEW): single `ALLOWED_ORDER_TRANSITIONS` + `validateOrderTransition()` + `assertOrderOwner()` replacing the 3 drifted copies in `src/modules/order/order.service.ts:19-28`, `src/modules/order/order-completion.service.ts:28-37,98-120`, `src/modules/order/order-cancellation.service.ts:40-65`; cancellation keeps its narrower target guard (CANCELLED/FAILED only) on top of the shared map (fixes F2 state-machine drift; CC-B consumes this helper in S2)
- [ ] T024 [US1] Unify inventory error mapping in `src/modules/order/order-cancellation.service.ts`: reuse the single `23514/CHK → 409` mapper from T023 helper file for the cancel path (fixes M2 variant drift on the touched copy; checkout/complete copies migrate in S6)
- [ ] T025 [US1] Remove `any` on touched cancel path in `src/modules/order/order-cancellation.service.ts:94,129,183`, `src/modules/order/order.controller.ts:9,152,249,259` (`req: any`, `result: any` on cancel handler only): typed `FindOneOptions` lock modes, `catch (error: unknown)` + narrowing, named `CancelOrderResult` return type (fixes M9 on touched lines; untouched `any` elsewhere stays for S6)
- [ ] T026 [US1] Add idempotency-skip counter parity in `src/modules/order/order-cancellation.service.ts:104-113`: `INCR idempotency:duplicate:skipped:cancel EX 86400` fail-open on the idempotent re-cancel branch, mirroring `OrderCompletionService.incrementCounter` (fixes M17 observability gap)
- [ ] T027 [US2] Guard null-product deref in `src/modules/order/order-checkout.service.ts:71,79`: map missing `ci.product` to `404 Product not found` instead of `TypeError → 500` (fixes F4 robustness hole on the shared checkout path)
- [ ] T028 [P] Delete dead code with DC-1 evidence in `src/modules/order/order.enum.ts` (0 importers — delete file), `src/modules/order/order.service.ts:167-176` (create/update/remove stubs, no callers), `src/modules/order/dto/create-order.dto.ts` + `src/modules/order/dto/update-order.dto.ts` (imported only by each other/stubs, controller uses CheckoutDto/CompleteOrderDto), `src/modules/order/entities/order.entity.ts:51-52` (`order_items?` alias, declaration-only); re-verify reachability at implementation, keep `OrderItem` snake_case getter aliases (M18 — live compat shims, do NOT touch)
- [ ] T029 [P] Remove dead `DataSource` injection in `src/modules/order/order-completion.service.ts:48` (zero reads of `this.dataSource`; tx is controller-owned) + extract `currency: 'usd'` in `src/modules/order/order-checkout.service.ts:235` to a named `ORDER_CURRENCY` constant (fixes M7 + M13)
- [ ] T030 [P] Remove unreachable `total < 0` guard in `src/modules/order/order-checkout.service.ts:181-183` (qty > 0 + price ≥ 0 enforced above make it dead) and document the price-snapshot-without-lock read in `src/modules/order/order-checkout.service.ts:81` as intentional snapshot semantics (fixes M14 + records M19 so nobody "fixes" it later)

### A2. Naming compliance — AGENTS.md §3 (audit 2026-10-06, was missing from review)

- [ ] T031 Rename generic verbs to entity+action in `src/modules/order/order-cancellation.service.ts` (`cancel()` → `cancelOrder()`), `src/modules/order/order-completion.service.ts` (`complete()` → `completeOrder()`, `incrementCounter()` → `incrementCompleteIdempotentSkipCounter()`), `src/modules/order/order-checkout.service.ts` (`checkout()` → `checkoutUserCart()`), `src/modules/order/order.controller.ts` (handlers `cancel/complete` → `cancelOrder/completeOrder`); update the sole caller (`OrderController`), unit/integration specs, and `src/modules/order/test/cancel-fixtures.ts` (T003). Safe: grep proves no external callers. Fold `assertOwner` → `assertOrderOwner()` into T023's shared helper
- [ ] T032 Replace truncated/vague locals on the touched cancel+controller path: `corrId` → `effectiveCorrelationId` (`order-cancellation.service.ts:88`, `order-checkout.service.ts:223`, `order-completion.service.ts:311`), `inv` → `inventory`, `item` → `checkoutItem`/`reservationItem` (AGENTS.md bans `item` explicitly), `ci` → `cartItem`, `prod` → `product` (`order-checkout.service.ts:67-119`), `resIdem`/`reservationRepoIdem` → `idempotentReservation…` (`order-completion.service.ts:173-183`), `res` → `linkedReservation`, `repo` → `orderRepository`/`reservationRepository` (`order.service.ts:56-127`), `req: any` → typed `request` (with T025). Accepted deviations (NOT renamed): `findAll`/`findOne` (codebase-wide repo convention — renaming one module creates inconsistency; belongs to a repo-wide pass), `{data, meta}` envelope (documented API convention), `N20` duplicate `OrderStatus` export resolved by T028 deletion

### B. Deferred to S6 / refactor track (no Phase 8 tasks — owners recorded)

| Finding | Why deferred | Owner |
|---------|--------------|-------|
| F1 siblings: outbox swallow in checkout (`order-checkout.service.ts:224-255`) + completion ×2 (`order-completion.service.ts:225-247,312-337`) | Same lost-event class as cancel but behavior-changing on checkout/complete paths; needs B-approval per REFACTOR_PLAN P0-8/B-11 | S6 RP-ORDER |
| F3: expiry auto-cancel best-effort catch (`reservation.service.ts:666-676`) vs cancel rollback | Intentional divergence (worker availability vs user-cancel durability); document in ADR-0014, do not unify | ADR-0014 (T019) |
| M3: N+1 `Promise.all(findOne Reservation)` (`order.service.ts:79-90`) | Read-path perf, single-query fix with EXPLAIN; already tracked in REFACTOR_PLAN RP-ORDER addendum | S6 RP-ORDER |
| M4: controller-owns-tx (complete/cancel) vs service-owns-tx (checkout) | TI-3 migration; Phase 8 keeps controller pattern for consistency (plan Complexity Tracking) | S6 RP-ORDER |
| M5: dual findOne under lock + double reservation load (completion:144-157,192-205) | Collapse only with redundancy proof (PQ-1); completion path untouched by Phase 8 | S6 RP-ORDER |
| M8 (remainder): `@Optional()` OutboxService/CACHE_MANAGER + `if (!this.x)` guards | OD-1 conversions need per-dep behavior records; cancel-path optionality fixed in T010/D7 | S6/S7 RP-OUTBOX/RP-NOTIF |
| M10: `randomUUID()`/`new Date()` in services; M11/M12/M15/M16: response mapper, correlation helper, pagination DTO, response DTOs, Swagger gaps | CC-A/CC-B shared ports + helpers; Phase 8 must NOT invent its own (would conflict with S2) | S2 shared primitives |
| M16 Swagger 401/429 parity on cancel | Covered by existing T020 | T020 |

**Checkpoint**: Review debt either fixed (A) or owned with a phase (B) — no finding left unaddressed

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, contract parity, full verification

- [ ] T018 Update `docs/plan.md` Phase 8 section: status DONE (demo scope), exit-bar evidence, refund deferral pointer
- [ ] T019 [P] Write `docs/decisions/0014-order-cancellation.md` (ADR: state machine, locked Q1/Q2/Q3 + clarify A-outcomes, D2 rollback, D4 expiry untouched, D7 OD-1, complexity-tracking deviations with S6 follow-up)
- [ ] T020 [P] Swaggerannotate `POST /order/:id/cancel` in `src/modules/order/order.controller.ts` (200 enriched schema, 403/404/409/429 responses per `specs/017-order-cancellation/contracts/order-cancel.md`)
- [ ] T021 Run full verification: `npm run lint`, `npm run build`, `npm run test -- --runInBand src/modules/order src/modules/reservation`, E2E cancel flow; record results in `specs/017-order-cancellation/tasks.md` notes
- [ ] T022 Re-check constitution gates from `specs/017-order-cancellation/plan.md` post-implementation and tick plan checkboxes with file/test evidence

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - US1 (P1) first — MVP; US2 needs US1's hardened service; US3 needs US1's outbox semantics
  - Strictly sequential here (same service file, same controller — parallel edits would conflict)
- **Polish (Final Phase)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Depends on US1 service hardening (T009) - expiry race test needs final lock/rollback semantics
- **User Story 3 (P3)**: Depends on US1 (T009/T010) - envelope assertions need final record behavior

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Service before controller; contract shape (T005) before both
- Story complete before moving to next priority

### Parallel Opportunities

- T002 + T004-adjacent prep can overlap (different files) but both land before Phase 2 exit
- T006, T007, T008 (US1 tests) can be written in parallel (different files)
- T013, T014 (US2 tests) can be written in parallel
- T019 + T020 (docs + Swagger) can run in parallel
- Implementation tasks within one story are SEQUENTIAL (shared `order-cancellation.service.ts` / `order.controller.ts`)

---

## Parallel Example: User Story 1 tests

```bash
# Launch all US1 test-writing tasks together (different files, no dependencies):
Task: "Unit matrix for cancel() in src/modules/order/order-cancellation.service.spec.ts"
Task: "Real-PG integration in src/modules/order/test/order-cancel.integration.spec.ts"
Task: "Concurrency proof in src/modules/order/test/order-cancel.concurrency.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T005)
3. Complete Phase 3: User Story 1 (T006–T012)
4. **STOP and VALIDATE**: quickstart steps 1–6 + SC-001/SC-002/SC-004 evidence
5. Demo-ready: cancel-before-sale works end to end

### Incremental Delivery

1. Setup + Foundational → harness ready
2. US1 → shopper cancel works (MVP!)
3. US2 → admin + expiry races proven
4. US3 → observability proven (SC-005)
5. Polish → docs + ADR + full verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Total: 32 tasks (Setup 2, Foundational 3, US1 7, US2 3, US3 2, Review 10, Polish 5)
- Review phase executes interleaved with US1/US2 (same files); IDs ordered after for stability
