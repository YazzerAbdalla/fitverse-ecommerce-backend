# Implementation Plan: Inventory Foundation (Phase 1)

**Branch**: `001-inventory-foundation` | **Date**: 2026-08-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-inventory-foundation/spec.md`

**Note**: This template is filled by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Introduce `Inventory` as a first-class TypeORM entity that owns `stock` and
`reserved_amount` for each `Product`, with database-enforced invariants
(`stock >= 0`, `reserved_amount >= 0`, `reserved_amount <= stock`) and `available`
derived (never stored). Reconcile the existing `Product.stock` column by seeding
`Inventory` from current product stock and then removing `Product.stock`. Expose
inventory through an `InventoryService` business API and a thin REST controller,
and redirect the existing `InventoryService` stock logic away from `Product`.

## Technical Context

**Language/Version**: TypeScript (Node.js), NestJS 11
**Primary Dependencies**: TypeORM, PostgreSQL 17, class-validator/class-transformer, Jest
**Storage**: PostgreSQL 17 (authoritative source of truth)
**Testing**: Jest — unit (`*.spec.ts`) + integration against a real PostgreSQL + e2e (`test/jest-e2e.json`)
**Target Platform**: Node.js server (single deployable NestJS process)
**Project Type**: web-service (modular monolith, REST + GraphQL)
**Performance Goals**: No phase-1-specific target; DB-enforced constraints are the priority
**Constraints**: `stock >= 0`, `reserved_amount >= 0`, `reserved_amount <= stock`; `available` is derived; `Product` must not own inventory state; module boundaries via exported `InventoryService`
**Scale/Scope**: One `Inventory` row per `Product` (one-to-one); small, well-bounded domain

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Result | Notes |
| --- | --- | --- |
| I. PostgreSQL is source of truth | PASS | Inventory state lives in PostgreSQL; no Redis/cache for inventory truth |
| II. Modular monolith | PASS | New `inventory` module; no microservices introduced |
| III. Inventory/Reservation separate domains | PASS | New `Inventory` entity with `stock`, `reserved_amount`; `available=stock-reserved_amount` derived, not stored |
| IV. DB-level concurrency / no overselling | PASS (deferred) | Pessimistic locking belongs to Phase 3; Phase 1 only establishes entities/constraints. No violation |
| V. Module boundaries / service-only | PASS | `InventoryService` exported; other modules call it, never `@InjectRepository(Inventory)` |
| VI. Spec-driven development | PASS | Spec + clarification completed before this plan |
| VII. Mandatory DB-backed tests | PASS | Plan includes integration tests against real PostgreSQL for constraints |
| VIII. No invented APIs/fields | PASS | Controller/endpoints derived from `docs/plan.md` §1.2–1.3; no new payment/fields |
| IX. Documentation is work | PASS | AGENTS.md + `docs/` updated; decision recorded in `docs/decisions/` |

No violations → no Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/001-inventory-foundation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── inventory-api.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/modules/inventory/
├── inventory.module.ts        # import ProductsModule; export InventoryService
├── inventory.controller.ts    # NEW — thin REST controller
├── inventory.service.ts       # EXTEND — business operations on Inventory entity
├── entities/
│   └── inventory.entity.ts    # NEW — Inventory entity + constraints
└── dto/
    ├── create-inventory.dto.ts     # NEW
    ├── update-inventory.dto.ts     # NEW (increase/decrease stock, reserve, release)
    └── inventory-response.dto.ts   # NEW (or reuse entity)

src/modules/products/
└── entities/product.entity.ts # MODIFY — remove `stock` column

src/modules/inventory/inventory.service.spec.ts # EXTEND — real tests
```

**Structure Decision**: Follow the existing `src/modules/<name>/` layout used by
`products`, `cart`, `order`. `inventory` already exists with a module + service;
we add `entities/`, `dto/`, and a controller. `Product` is modified in place to
drop `stock`. No new top-level directories.

## Complexity Tracking

> No constitution violations. Section intentionally left empty.
