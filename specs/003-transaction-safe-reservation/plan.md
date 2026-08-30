# Implementation Plan: Transaction-Safe Reservation (Phase 3)

**Branch**: `003-transaction-safe-reservation` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-transaction-safe-reservation/spec.md` (Phase 3 — `docs/plan.md` §§3.1-3.4)

## Summary

Make reservation **creation** atomic and concurrency-safe: `BEGIN → lock all requested Inventory rows FOR UPDATE in deterministic order → check available = stock - reservedAmount >= requested_quantity per item → increment reservedAmount → insert Reservation + ReservationItems → COMMIT`, else `ROLLBACK`. Prevent overselling so that two concurrent requests for the last `available` units yield exactly one success + one `409`. No new tables/migrations, no Redis/RabbitMQ inside the transaction, no lifecycle mutations (complete/cancel/expire inventory effects deferred to Phase 4). Approach is a focused augmentation of `ReservationService.create(manager,...)` with pessimistic row locking, mirroring precedent `products.service.ts:updateMany` (`pessimistic_write`).

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11
**Primary Dependencies**: `@nestjs/common`, `@nestjs/typeorm` 11 + `typeorm` 1.1, `class-validator`/`class-transformer`, `passport`+`@nestjs/jwt`+`bcrypt` (auth), `Jest`+`ts-jest`+`supertest`
**Storage**: PostgreSQL 17 via TypeORM; Redis 8 (`@nestjs/cache-manager` + `@keyv/redis`) — cache-only, **not** used inside reservation transaction; RabbitMQ 4 + BullMQ available but not used in this phase
**Testing**: Jest unit (`*.spec.ts`), integration + concurrency against **real PostgreSQL** (docker), E2E via `test/jest-e2e.json` + `supertest`; `npm run test`, `npm run test:e2e`, `npm run test:cov`
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq)
**Project Type**: Modular monolithic backend — REST (`auth`, `cart`, `order` stub) + GraphQL (`products`), global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform), `AllExceptionsFilter`, `JwtGuard`/`RolesGuard`/`Auth`/`CurrentUser`
**Performance Goals**: Transaction short (only lock→check→increment→insert); row-level locking, not table-level, so disjoint inventories run in parallel; lock wait serialized via `FOR UPDATE` queue
**Constraints**: `synchronize: false` (no auto DDL); PostgreSQL is authoritative (`constitution I`); transaction must not contain external I/O (Redis/RabbitMQ/BullMQ/email); only requested `Inventory` rows are locked; `reservedAmount <= stock` + `quantity>0` enforced by DB `CHECK`
**Scale/Scope**: Affects `src/modules/reservation/reservation.service.ts` (primary), `reservation.controller.ts` (unchanged wrapping), `src/modules/inventory/entities/inventory.entity.ts` (read via lock, no schema change); 1 service method augmented, 0 new modules, 0 new migrations; tests: unit + integration + concurrency (real PG)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ **PASS** | Availability computed inside `FOR UPDATE` transaction from `Inventory` row; cache/RabbitMQ never feed reservation decision (`spec.md` A1, FR-005, research D7) |
| **II. Modular monolith — no premature microservices** | ✅ **PASS** | Single `reservation` module, no new services/processes; cross-module only via exported `ReservationService` |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ **PASS** | No new states; `RESERVED` only on create; inventory effect is exactly `reservedAmount += qty` on create (FR-001), lifecycle decrements deferred to Phase 4 per FR-009/A10 |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ **PASS** | Core deliverable: `FOR UPDATE` + deterministic ordering + `available >= requested` check atomically; concurrency test SC-003 proves no oversell (research D1-D3) |
| **V. Module boundaries, service-only collaboration** | ✅ **PASS** | `ReservationService` sole mutator; controller thin, wraps in `dataSource.transaction(manager => service.create(...))`; no `@InjectRepository` of another module's entity |
| **VI. Spec-driven development** | ✅ **PASS** | Spec (`spec.md`) + clarify (0 ambiguities) done before plan; no silent assumption implementation; Phase 4-15 explicitly out of scope |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ **PASS** | Concurrency + rollback assertions run against real PostgreSQL (FR-010, research D8); `npm run test`/`test:e2e` required |
| **VIII. No invented APIs/payments/business rules** | ✅ **PASS** | Only existing `POST /reservations` + `CreateReservationDto`; no payment, no `Idempotency-Key`, no new invented fields (FR-006, research D7) |
| **IX. Documentation is part of work** | ✅ **PASS** | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/003-transaction-safe-reservation/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` Tech/DoD traceable |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (no new gates introduced by research/data-model/contracts).

## Project Structure

### Documentation (this feature)

```text
specs/003-transaction-safe-reservation/
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output — decisions D1-D8, risks
├── data-model.md        # Phase 1 output — entity/transaction model, no new DDL
├── quickstart.md        # Phase 1 output — manual + test quickstart
├── contracts/
│   └── reservation-api.md  # Phase 1 output — POST /reservations transactional contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── reservation/
│   │   ├── reservation.service.ts         # PRIMARY: augment create() with locking/availability/mutation
│   │   ├── reservation.controller.ts      # unchanged (still dataSource.transaction wrapper)
│   │   ├── reservation.module.ts          # unchanged (exports ReservationService)
│   │   ├── dto/create-reservation.dto.ts  # unchanged
│   │   ├── entities/reservation.entity.ts # unchanged
│   │   ├── entities/reservation-item.entity.ts # unchanged
│   │   ├── entities/reservation-status.enum.ts # unchanged
│   │   ├── reservation.service.spec.ts    # extend: unit tests for locking path
│   │   └── test/
│   │       ├── reservation.integration.spec.ts  # extend: real-PG rollback/concurrency tests
│   │       └── reservation.concurrency.spec.ts  # optional: explicit concurrency file
│   ├── inventory/
│   │   └── entities/inventory.entity.ts   # unchanged (available getter, CHECKs)
│   ├── products/
│   │   └── products.service.ts            # reference: pessimistic_write precedent (updateMany)
│   ├── auth/ users/ cart/ order/ app.module.ts, data-source.ts  # unchanged
├── migration/                             # NO new migration in Phase 3
└── test/app.e2e-spec.ts                   # optional: e2e coverage for POST /reservations concurrency
```

**Structure Decision**: Single project (Option 1) — augment the existing `src/modules/reservation/` service in place; no new modules, no new migrations, no new infrastructure. Aligns with modular monolith and `AGENTS.md` backend/module rules.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
*No violations — table intentionally empty.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in spec). Key decisions: D1 pessimistic `FOR UPDATE`, D2 lexicographic `inventoryId` ordering, D3 derived `available` check on locked row, D4 controller-owned `dataSource.transaction` + manager-passed service, D5 `manager.save` increment with DB CHECK backstop, D6 error mapping `409`/`404`/`400`, D7 short transaction without external I/O, D8 real-PG concurrency tests. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): No new tables/columns; transaction model `lock(sortedIds) → check available → increment reservedAmount → insert Reservation+Items`; validation/Error table; indexes/constraints unchanged.
- **Contracts** → [contracts/reservation-api.md](./contracts/reservation-api.md): `POST /reservations` transactional contract (201 + reservedAmount increment vs 409/404/400 + rollback), concurrency guarantees, unchanged routes table, error serialization.
- **Quickstart** → [quickstart.md](./quickstart.md): Build/lint/test, manual curl/psql verification for happy path, rejections, concurrent `qty=2 vs qty=2`, opposite-order deadlock avoidance, DB checks.

### Agent context update

`AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/003-transaction-safe-reservation/plan.md`) via the plan script (step 3 of /speckit.plan). Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). No new complexity to justify.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 3 into ordered tasks (e.g.: 1) write failing concurrency integration test `stock=10,reserved=8 qty=2 vs qty=2`; 2) augment `ReservationService.create` with sorted `FOR UPDATE`, `available` check, `reservedAmount` increment, error mapping; 3) unit tests for ordering/lock path; 4) opposite-order deadlock test; 5) verify `npm run lint/build/test/test:e2e`.
