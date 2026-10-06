# Implementation Plan: Order Cancellation (Phase 8, demo scope)

**Branch**: `017-order-cancellation` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-order-cancellation/spec.md`

## Summary

Complete Phase 8 demo scope (cancel-before-sale only) by hardening the
existing `OrderCancellationService` + `POST /order/:id/cancel` to the
spec: remove the outbox swallow so record-write failure rolls back (Q2/A),
return the enriched cancel shape (FR-012), require the service dependency
(OD-1), and prove the exit bar (no double-release / double-return) with
unit + real-PostgreSQL integration + concurrency + E2E tests. No schema
change, no new routes, no refund behavior.

## Technical Context

**Language/Version**: TypeScript 5.x, NestJS 11 (modular monolith)
**Primary Dependencies**: TypeORM (`typeorm` ^1.1, `pessimistic_write`),
  `@nestjs/jwt` auth (`@Auth()`, `JwtGuard`+`RolesGuard`), `OutboxService`
  (transactional outbox), `RateLimitGuard` (existing route guard)
**Storage**: PostgreSQL 17 (authoritative: `Order`, `Reservation`,
  `ReservationItem`, `Inventory`, `OutboxEvent`); Redis read-only infra
  (rate-limit counters, fail-open — untouched)
**Testing**: Jest (`ts-jest`): `*.spec.ts` unit (mocked `EntityManager`),
  real-PostgreSQL integration + `Promise.all` single-winner concurrency,
  `supertest` E2E (`test/jest-e2e.json`)
**Target Platform**: Linux server / Docker Compose (postgres, redis, rabbitmq)
**Project Type**: Backend web-service (REST `/order`, GraphQL untouched)
**Performance Goals**: Cancel completes in one short transaction (lock →
  mutate → outbox → commit, no I/O inside tx); expiry 60s-SLA path untouched
**Constraints**: `synchronize: false` (no DDL); global `ValidationPipe`
  (whitelist + forbidNonWhitelisted); `AllExceptionsFilter` envelope;
  JSDoc + `//` intent comments per AGENTS.md §3; no new `any`
**Scale/Scope**: Demo scope — ~5 files touched, 0 migrations, 0 new routes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Note |
|-----------|--------|------|
| I. PG source of truth | ✅ Pass | All cancel writes are PG via `EntityManager`; outbox row in same tx (TI-4 after D2) |
| II. Modular monolith / service-only | ⚠️ Acknowledged deviation | `OrderCancellationService` reads/writes `Reservation`+`Inventory` repos directly instead of via their services (same pattern as Phase 7 `OrderCompletionService`; see Complexity Tracking). Controllers stay thin |
| III. Explicit lifecycles | ✅ Pass | State machine in `data-model.md`; fixed per-transition inventory effects; refund excluded |
| IV. DB-level concurrency | ✅ Pass | `FOR UPDATE` Order → Reservation → sorted Inventories; `Promise.all` single-winner proof required in tasks |
| V. Thin controllers | ✅ Pass | Controller parses auth/correlationId, delegates, shapes response |
| VI. Spec-driven | ✅ Pass | spec + clarify sessions 2026-10-06 complete, zero open markers |
| VII. DB-backed tests | ✅ Pass (gated) | Tasks must include real-PG integration + concurrency; mocks only for unit |
| VIII. No invented APIs | ✅ Pass | Route exists; response extended additively per FR-012; no new endpoints |
| IX. Docs as work | ✅ Pass (gated) | `docs/plan.md` Phase 8 status + ADR update required in tasks |

Post-design re-check: no new violations introduced by Phase 1 artifacts
(research/data-model/contracts/quickstart are docs-only).

## Project Structure

### Documentation (this feature)

```text
specs/017-order-cancellation/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── order-cancel.md
├── checklists/
│   └── requirements.md  # Spec quality gate (all pass)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── order/
│   │   ├── order-cancellation.service.ts   # harden: D2/D3/D6/D7 + typed locks
│   │   ├── order.controller.ts             # cancel: required dep + enriched shape
│   │   ├── order.module.ts                 # unchanged (provider already registered)
│   │   ├── order-cancellation.service.spec.ts      # NEW unit tests
│   │   └── test/
│   │       ├── order-cancel.integration.spec.ts    # NEW real-PG tests
│   │       └── order-cancel.concurrency.spec.ts    # NEW single-winner races
│   ├── reservation/
│   │   └── reservation-expiration.service.ts  # UNTOUCHED (D4)
│   └── outbox/
│       └── outbox.service.ts                  # UNTOUCHED (API reused as-is)
test/
└── app.e2e-spec.ts / order-cancel.e2e-spec.ts  # E2E: checkout → cancel → verify
docs/
├── plan.md                                     # Phase 8 status → DONE (demo)
└── decisions/
    └── 0014-order-cancellation.md              # NEW ADR (state machine + Q1/Q2/Q3 + D2)
```

**Structure Decision**: Single-project layout, existing module files only; new
test files co-located per repo convention (`*.spec.ts` + `test/`).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| II/TI-1: `OrderCancellationService` touches `Reservation`/`Inventory` repos directly | Consistency with the proven Phase 7 `OrderCompletionService` pattern in the same checkout→complete→cancel money flow; routing through `ReservationService`/`InventoryService` mid-phase would change lock ordering (D5) and widen blast radius to the expiry path | Deferring to `docs/REFACTOR_PLAN.md` S6 (RP-ORDER intent-based stores), which owns the TI-1/TI-3 cleanup with its own tests |
| Controller-owned tx (TI-3) removed in Phase 8 | User-directed: `OrderController` drops `DataSource` entirely; `cancelOrder`/`completeOrder` own their transactions with `…WithManager` cores for composition (T033–T035). Checkout already service-owned | Uniform service-owned boundary is better than file-level consistency with a known violation |

## Phase 2 Handoff (for `/speckit.tasks`)

Tasks must cover, at minimum: service hardening (D2/D3/D6/D7 + `as any`
removal on lock options), controller wiring + response shape, unit matrix
(PENDING→CANCELLED/FAILED, idempotent re-cancel, 403/404/409, failed-path
reservation disposition), real-PG integration (atomicity, outbox rollback on
forced record failure, reservation-already-terminal, missing inventory),
concurrency (`cancel vs cancel`, `cancel vs complete`, `cancel vs expire`
single-winner, zero double-delta), E2E (quickstart flow + negative matrix
rows N-capable), docs (`docs/plan.md`, ADR-0014), verification
(`lint`/`build`/`test`/`test:e2e` relevant suites green).
