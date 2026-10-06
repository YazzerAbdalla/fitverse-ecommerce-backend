# Tasks: Reconcile + Baseline (S1)

**Input**: Design documents from `/specs/016-baseline/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — the spec's acceptance scenarios and independent-test criteria explicitly require them (SC-001..SC-005, FR-007..FR-011).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm branch, live infrastructure, and the green starting point

- [ ] T001 Verify branch `016-baseline`, start infrastructure via `docker-compose up -d`, and confirm `npm run build` passes
- [ ] T002 [P] Record baseline `git status` / `git log --oneline -10` output as the S1 starting point in `specs/016-baseline/tasks.md` notes
- [ ] T003 [P] Run `npx jest src/modules/outbox/test --runInBand` and `npx jest src/modules/auth --runInBand` once to capture the pre-change green state

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Reconcile merged work vs plan (FR-011) — determines every gap later phases fill

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Write the reconcile checklist mapping every Phase 0 / S1 plan item (`docs/REFACTOR_PLAN.md` §14 S1 + §13 P0-6/P0-7) to done-with-evidence or open, cross-checked against `git log` (RP-AUTH + token-fold commits)
- [ ] T005 Inventory existing pin suites (`src/modules/auth/test/jwt-paths.integration.spec.ts`, `token-races.integration.spec.ts`, `verify/resend` suites, `baseline-parity.integration.spec.ts`) and record exactly which P0-2–P0-5 pins exist vs are missing

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Expired outbox records are actually removed (Priority: P1) 🎯 MVP

**Goal**: Fix the retention predicate so expired terminal rows are deleted (P0-1 `[B]`), as an isolated single-purpose commit

**Independent Test**: Seed old/fresh terminal + old non-terminal rows per `contracts/retention-cleanup.md`; only expired terminal rows disappear with count reported

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T006 [US1] Write the 9-row retention regression matrix in `src/modules/outbox/test/outbox-cleanup.retention.spec.ts` (real PostgreSQL) and confirm it FAILS on the current predicate

### Implementation for User Story 1

- [ ] T007 [US1] Fix the `DELETE` predicate + parameter list in `src/modules/outbox/outbox-cleanup.service.ts` per `contracts/retention-cleanup.md` (explicit 5-status list, `COALESCE(sentAt, createdAt)` for success legs, `createdAt` for `FAILED`; clamp + log shape unchanged), committed solo with no other change
- [ ] T008 [US1] Run `npx jest src/modules/outbox/test --runInBand` green and verify the fix commit contains only `src/modules/outbox/outbox-cleanup.service.ts` + the new spec

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Leaked secrets rotated and gated (Priority: P1)

**Goal**: Strip live credentials to placeholders, prove git-ignore, and enforce a two-layer secret gate (P0-6 `[S]` ops)

**Independent Test**: On-disk file matches placeholder pattern, `git check-ignore .env` passes, gate rejects planted fake keys and passes placeholders

- [ ] T009 [US2] Strip live values in `.env` to placeholders matching `.env.example` (patterns `re_xxx…`, empty secrets), verify `git check-ignore .env`, and record provider-side rotation status + approvals (Appendix B-7) in the reconcile checklist
- [ ] T010 [P] [US2] Create the pattern scan script in `scripts/scan-secrets` (`re_[A-Za-z0-9_]{20,}` + `GOCSPX-`, placeholders must pass)
- [ ] T011 [P] [US2] Create the CI enforcement step in `.github/workflows/secret-scan.yml` running `scripts/scan-secrets`
- [ ] T012 [US2] Wire and document the local pre-commit hook for `scripts/scan-secrets`, then prove reject-on-fake / pass-on-placeholder behavior end to end

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - Browsers limited to listed origins (Priority: P2)

**Goal**: Replace `origin: true` with a config-driven allow-list, credentials scoped to listed origins (P0-7 `[S]`)

**Independent Test**: Listed origin accepted with credentials, unlisted rejected, origin-less client unaffected, per `contracts/cors-allowlist.md`

### Tests for User Story 3 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T013 [P] [US3] Write the 4-row CORS origin matrix test in `test/cors.e2e-spec.ts` and confirm it FAILS on the current `origin: true` behavior

### Implementation for User Story 3

- [ ] T014 [US3] Implement the allow-list in `src/main.ts` (`[FRONTEND_URL, ...CORS_ORIGINS]`, no-origin bypass, production fail-closed + boot warn) and document `CORS_ORIGINS=` in `.env.example`
- [ ] T015 [US3] Run `test/cors.e2e-spec.ts` plus existing e2e suites green with `FRONTEND_URL` + `CORS_ORIGINS` set

**Checkpoint**: All user stories so far should now be independently functional

---

## Phase 6: User Story 4 - Auth edge behavior pinned (Priority: P2)

**Goal**: Lock current dual-path / reset-window / realtime outcomes with tests; zero production change (P0-2–P0-4)

**Independent Test**: Named pins pass on unmodified behavior and fail loudly on any future behavior change

- [ ] T016 [US4] From the Phase 2 gap list, confirm which of the three pins already exist (dual-path revoked matrix, validate-plus-reset window, revoked-user realtime) and write only the missing ones beside existing suites in `src/modules/auth/test/`
- [ ] T017 [P] [US4] Add the revoked-user realtime-connection pin (P0-4) in `src/modules/auth/test/` if missing from the inventory
- [ ] T018 [P] [US4] Add the concurrent validate-plus-reset documentation test (P0-3) in `src/modules/auth/test/` if missing from the inventory
- [ ] T019 [US4] Run `npx jest src/modules/auth src/modules/users --runInBand` green and prove zero production diff for this story (`git diff --stat` shows test-only files)

**Checkpoint**: Pins locked; later unification decisions now have evidence to decide against

---

## Phase 7: User Story 5 - Hot-flow baselines green (Priority: P3)

**Goal**: One green suite per hot flow on unmodified code + a zero-ambiguity reconcile checklist (P0-5, FR-010–FR-011)

**Independent Test**: Full baseline suite green; every plan item done-with-evidence or open

- [ ] T020 [US5] Fill the hot-flow baseline gaps found in Phase 2 (session rotation/theft, checkout totals/snapshots, completion idempotency, verification/resend, outbox claim/publish/retry, last-unit races) with suites beside existing specs
- [ ] T021 [US5] Run `npm run test -- --runInBand` fully green against live infrastructure (no close on skips) and record per-flow results
- [ ] T022 [US5] Finalize the reconcile checklist: every Phase 0 / S1 item marked done-with-evidence or open, zero items ambiguous

**Checkpoint**: All user stories should now be independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Close-out gates and plan bookkeeping for the S1 → S2 handoff

- [ ] T023 Run `npm run lint` clean for all touched files
- [ ] T024 Run `npm run build` clean
- [ ] T025 Run `npm run test` and `npm run test:e2e` (relevant suites) green
- [ ] T026 [P] Validate `specs/016-baseline/quickstart.md` end to end (retention seed check, CORS curl matrix, secret-gate drill)
- [ ] T027 [P] Tick `docs/REFACTOR_PLAN.md` S1 checkboxes with evidence (files, behavior delta, tests)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P1 → P2 → P2 → P3)
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories; ships as an isolated commit per FR-002
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - Independent (scripts/CI/env); human provider rotation tracked, not coded
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Independent (`src/main.ts` + e2e); needs approval B-8 before merge
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) - Test-only, strictly no production change
- **User Story 5 (P3)**: Can start after Foundational (Phase 2) - Test-only; closes S1 only when fully green on live infra

### Within Each User Story

- Tests MUST be written and FAIL before implementation (US1, US3)
- Pins/baselines assert current behavior without changing it (US4, US5)
- Story complete before moving to next priority
- P0-1 fix commit contains only the fix + its spec (FR-002)

### Parallel Opportunities

- T002 + T003 (setup reads/runs on different surfaces) can run in parallel
- T010 + T011 (scan script vs CI workflow, different files) can run in parallel
- T013 (CORS e2e test) can be written in parallel with US1/US2 implementation work (different files, no dependency)
- T017 + T018 (two pin specs, different files) can run in parallel
- T026 + T027 (quickstart validation vs plan bookkeeping) can run in parallel
- After Foundational completes, US1–US5 can proceed in parallel if staffed (recommended solo order: US1 → US2 → US3 → US4 → US5)

---

## Parallel Example: User Story 2

```bash
# Launch US2's independent creations together (different files, no dependencies):
Task: "Create the pattern scan script in scripts/scan-secrets"
Task: "Create the CI enforcement step in .github/workflows/secret-scan.yml"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (retention fix, isolated commit)
4. **STOP and VALIDATE**: Run the 9-row retention matrix green; verify commit purity
5. Merge P0-1 solo if desired — the table stops growing from here

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → retention fixed, merged solo (MVP!)
3. Add User Story 2 → secrets stripped + gated (needs human rotation alongside)
4. Add User Story 3 → CORS closed (needs approval B-8)
5. Add User Stories 4 + 5 → behavior pinned, baselines green (test-only, safe anytime)
6. Polish → S1 closes, S2 unblocked

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (retention fix)
   - Developer B: User Story 2 (secrets + gates)
   - Developer C: User Story 3 (CORS test + fix)
3. US4/US5 (test-only) can be picked up by anyone once the gap list exists
4. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (US1 T006, US3 T013)
- Commit after each task or logical group; P0-1 fix ships solo
- Stop at any checkpoint to validate story independently
- S1 production diff budget: exactly `src/modules/outbox/outbox-cleanup.service.ts` + `src/main.ts`; everything else is scripts/tests/docs/config-placeholders
