# Implementation Plan: Reservation Lifecycle (Phase 4)

**Branch**: `004-reservation-lifecycle` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-reservation-lifecycle/spec.md` (Phase 4 — `docs/plan.md` §§4.1-4.5 + clarifications Session 2026-09-14)

## Summary

Make every reservation lifecycle transition explicit, transactional, and inventory-synchronized. Augment `ReservationService.complete/cancel/expire` (currently status-only stubs `src/modules/reservation/reservation.service.ts:202-243`) to execute inside `dataSource.transaction(manager => service.*(manager,...))` as `BEGIN → lock Reservation FOR UPDATE → validateTransition (RESERVED→COMPLETED|CANCELLED|EXPIRED) + assertOwner → lock all referenced Inventory rows FOR UPDATE in deterministic sorted order → mutate inventory per spec (COMPLETED: `stock-=qty` `reservedAmount-=qty`; CANCELLED/EXPIRED: `reservedAmount-=qty`; stock unchanged) → update `Reservation.status` (and `orderId` on complete with overwrite) → COMMIT` else `ROLLBACK`. Handle clarified edge semantics: manual admin `expire` is an immediate override (no `expiresAt <= NOW()` check; Phase 5 worker will enforce), no service-level `stock>=qty` guard on complete (DB `@Check stock>=0` is final safety net), `orderId` on complete always overwrites, `COMPLETED→COMPLETED` retry is idempotent `200` (no re-mutation) while all other terminal retries remain `409`. No new tables/migrations expected; row-level pessimistic locking + sorted ordering mirrors Phase 3 precedent.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11
**Primary Dependencies**: `@nestjs/common` (11.1.28), `@nestjs/typeorm` 11 + `typeorm` 1.1, `class-validator`/`class-transformer`, `passport`+`@nestjs/jwt`+`bcrypt` (auth), `Jest`+`ts-jest`+`supertest`, `pg` 8.22
**Storage**: PostgreSQL 17 via TypeORM; Redis 8 (`@nestjs/cache-manager` + `@keyv/redis`) — cache-only, **not** used inside lifecycle transactions; RabbitMQ 4 + BullMQ available but not used in this phase (Phase 11 post-commit only)
**Testing**: Jest unit (`*.spec.ts` mocked `EntityManager` for guards), integration + concurrency + idempotent-retry against **real PostgreSQL** (docker, `--runInBand`), E2E via `test/jest-e2e.json` + `supertest`; `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq)
**Project Type**: Modular monolithic backend — REST (`auth`, `cart`, `order` stub) + GraphQL (`products`), global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform), `AllExceptionsFilter`, `JwtGuard`/`RolesGuard`/`Auth`/`CurrentUser`
**Performance Goals**: Lifecycle transaction short (only lock→check→mutate→save; no external I/O); row-level `FOR UPDATE` on `Reservation` + requested `Inventory` rows only, so disjoint reservations run in parallel; deterministic lock ordering prevents deadlocks on multi-item reservations
**Constraints**: `synchronize: false` (no auto DDL); PostgreSQL is authoritative (`constitution I`); transaction must use passed `EntityManager` (`manager.getRepository(...)`) never global repo; `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`, `quantity>0` enforced by DB `CHECK`; `available = stock - reservedAmount` derived, never client-supplied; error mapping `409` invalid transition / `403` forbidden / `404` not found / `400` validation
**Scale/Scope**: Affects `src/modules/reservation/reservation.service.ts` (3 methods: `complete`/`cancel`/`expire` + helper `transition` + `validateTransition`/`assertOwner`) and `reservation.controller.ts` (already wraps in `dataSource.transaction`, no signature change beyond idempotent `200` semantics); potentially `reservation.service.spec.ts` and `reservation/integration.spec.ts`; 0 new modules, 0 new migrations expected (allowed only if proven needed); tests: unit + integration (real PG) + concurrency race (`complete` vs `cancel`)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ **PASS** | Inventory mutation (`stock`/`reservedAmount`) and status computed exclusively inside `FOR UPDATE` transaction from locked `Inventory`/`Reservation` rows; `available` derived, never from Redis; no cache/RabbitMQ I/O inside transaction (`spec.md` FR-001,A1) |
| **II. Modular monolith — no premature microservices** | ✅ **PASS** | Single `reservation` module in place; no new services/processes; cross-module only via exported `ReservationService` and `Order` existence check via `manager.getRepository(Order)` (read-only) |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ **PASS** | No new states; only `RESERVED→COMPLETED\|CANCELLED\|EXPIRED` per constitution III; inventory effects exactly as spec `FR-002/FR-003` (`COMPLETED`: `stock-=qty`+`reserved-=qty`, `CANCELLED`/`EXPIRED`: `reserved-=qty`); idempotent `COMPLETED→COMPLETED` clarified as retry-safe success per Session Q4, others remain `409` |
| **IV. Concurrency safety at DB level (no overselling/double-release)** | ✅ **PASS** | Core deliverable: `FOR UPDATE` on `Reservation` then sorted `Inventory` rows, deterministic ordering, single-winner race (spec FR-001,FR-008, SC-005); DB `CHECK` backstop per Q2; concurrency tests required (research D1-D3) |
| **V. Module boundaries, service-only collaboration** | ✅ **PASS** | `ReservationService` sole mutator of `Inventory`/`Reservation` in lifecycle; controller thin, owns `dataSource.transaction(manager=>…)`; no `@InjectRepository` of another module's entity; `EntityManager` pattern per `AGENTS.md` §3 |
| **VI. Spec-driven development** | ✅ **PASS** | Spec `spec.md` + 5 clarify Q&A (Session 2026-09-14) done before plan; no silent assumptions (Q1 expire override, Q2 stock guard, Q3 orderId overwrite, Q4/Q5 idempotency all clarified); Phase 5-15 explicitly out of scope |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ **PASS** | Concurrency race (`complete` vs `cancel`) + rollback + idempotent retry + real-PG integration required (`FR-010`, SC-001..005); unit mocks only for guard logic; `npm run test -- --runInBand` + `test:e2e` required; research D8 |
| **VIII. No invented APIs/payments/business rules** | ✅ **PASS** | Only existing `PATCH /reservations/:id/complete|cancel|expire` + `dto.orderId` existence check; no payment, no new states/fields, no `Idempotency-Key` header beyond clarified `COMPLETED` idempotency (research D7) |
| **IX. Documentation is part of work** | ✅ **PASS** | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/004-reservation-lifecycle/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` Tech/DoD traceable |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (no new gates introduced by research/data-model/contracts).

## Project Structure

### Documentation (this feature)

```text
specs/004-reservation-lifecycle/
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output — decisions D1-D10, risks
├── data-model.md        # Phase 1 output — entity/transaction model, no new DDL
├── quickstart.md        # Phase 1 output — manual + test quickstart
├── contracts/
│   └── reservation-lifecycle-api.md  # Phase 1 output — PATCH lifecycle contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── reservation/
│   │   ├── reservation.service.ts         # PRIMARY: complete/cancel/expire → locking + inventory per FR-001..008 + Q1-5 clarifications + idempotent COMPLETED
│   │   ├── reservation.controller.ts      # already dataSource.transaction wrapper; no signature change (still 200 on idempotent COMPLETED per Q4)
│   │   ├── reservation.module.ts          # unchanged (exports ReservationService)
│   │   ├── dto/
│   │   │   ├── create-reservation.dto.ts  # unchanged
│   │   │   └── update-reservation-status.dto.ts # unchanged (orderId optional on complete)
│   │   ├── entities/
│   │   │   ├── reservation.entity.ts      # unchanged (status enum, indexes, FKs)
│   │   │   ├── reservation-item.entity.ts # unchanged (quantity>0 CHECK, unique)
│   │   │   └── reservation-status.enum.ts # unchanged
│   │   ├── reservation.service.spec.ts    # extend: unit tests for validateTransition, assertOwner, idempotent COMPLETED, overwrite orderId, Q1-5 edges
│   │   └── test/
│   │       └── reservation.integration.spec.ts  # extend: real-PG lifecycle tests (COMPLETED/CANCELLED/EXPIRED, invalid 409, missing inventory rollback, concurrent complete vs cancel, idempotent retry, concurrent same-id)
│   ├── inventory/
│   │   └── entities/inventory.entity.ts   # unchanged (stock/reservedAmount/available, CHECKs)
│   ├── order/
│   │   └── entities/order.entity.ts       # read-only existence check on complete
│   ├── auth/ users/ products/ cart/ app.module.ts, data-source.ts  # unchanged
├── migration/                             # NO new migration expected in Phase 4 (allowed only if proven needed)
└── test/
    └── app.e2e-spec.ts                    # existing hello e2e; optional lifecycle e2e can be added later (Phase 14)
```

**Structure Decision**: Single project (Option 1) — augment the existing `src/modules/reservation/` service methods in place (`complete`/`cancel`/`expire` + shared `transition` helper) with transactional locking per `AGENTS.md` backend/module rules; no new modules, no new infra.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
*No violations — table intentionally empty.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 clarify Q&A in spec Session 2026-09-14 now integrated). Key decisions: D1 `FOR UPDATE` on Reservation then inventories, D2 lexicographic sorted lock ordering, D3 manual expire no time guard (Q1), D4 stock guard via DB CHECK only (Q2), D5 orderId overwrite (Q3), D6 idempotent `COMPLETED→COMPLETED` 200 vs other terminals 409 (Q4/Q5), D7 error mapping + service `EntityManager` pattern, D8 real-PG concurrency/rollback/idempotent tests. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): No new tables/columns (uses existing `Reservation`/`ReservationItem`/`Inventory`/`Order`); transaction model `lock Reservation FOR UPDATE → lock sorted Inventories FOR UPDATE → mutate per FR-002/FR-003 → save`; validation/error/Q-clarification table; indexes/constraints unchanged.
- **Contracts** → [contracts/reservation-lifecycle-api.md](./contracts/reservation-lifecycle-api.md): `PATCH /:id/complete` (complete + orderId overwrite + idempotent `200`), `PATCH /:id/cancel`, `PATCH /:id/expire` (admin, immediate override) — all inside `dataSource.transaction`; error serialization `409`/`403`/`404`/`400`; race single-winner guarantee.
- **Quickstart** → [quickstart.md](./quickstart.md): Build/lint/test (`--runInBand`), manual curl/psql verification for each transition (happy, invalid, concurrent race, idempotent retry, orderId overwrite), DB `CHECK` backstop verification.

### Agent context update

`AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/004-reservation-lifecycle/plan.md`) via `setup-plan.ps1` + manual correction of `AGENTS.md` (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md` or `cat AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Clarifications Q1-Q5 are consistent with constitution III/IV/VII and do not introduce new state, new infra, or cache-based decisions. No new complexity to justify.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 4 into ordered tasks (e.g.: 1) failing integration tests for `RESERVED→COMPLETED`/`CANCELLED`/`EXPIRED` inventory effects; 2) failing `409` invalid-transition tests; 3) implement transactional `transition` helper with `FOR UPDATE` sorted locks + FR-002/003 mutations + Q1-Q5 semantics + error mapping; 4) failing concurrent `complete` vs `cancel` race + idempotent `COMPLETED` retry tests; 5) verify `npm run lint/build/test -- --runInBand` and E2E `test/jest-e2e.json`).
