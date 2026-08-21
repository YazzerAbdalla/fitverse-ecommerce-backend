# ADR 0008: Inventory Owns Stock — Remove `Product.stock`

**Date**: 2026-08-21
**Status**: Accepted
**Feature**: 001-inventory-foundation (Phase 1)

## Context

`Product.stock` was the source of truth for quantity on hand. `InventoryService` mutated `Product.stock` directly and no `Inventory` entity existed. This violated Phase 0 decisions: *Product does not own inventory state*, *Inventory is a separate domain*, *PostgreSQL is the transactional source of truth* (AGENTS.md, `docs/plan.md` §Phase 0–1).

Keeping `stock` on `Product` creates a second source of truth, risks drift, and blocks reservation lifecycle (reservedAmount / available) and concurrency controls planned for Phases 2–4.

Options considered:
1. Keep `Product.stock` as read-only mirror — rejected; drift risk, dual truth.
2. Keep `Product.stock` authoritative, `Inventory` only tracks `reservedAmount` — rejected; contradicts Phase 0.
3. **Remove `Product.stock`, Inventory owns `stock` + `reservedAmount`** — chosen.

## Decision

- Introduce `Inventory` entity (`id`, `productId` Unique+Indexed, `stock`, `reservedAmount`, `createdAt`, `updatedAt`, derived `available = stock - reservedAmount`) with DB checks (`stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`).
- One-to-one `Inventory` (owns FK) → `Product`; `Product` has inverse read-only `@OneToOne(() => Inventory)`.
- Before dropping the column, seed one `Inventory` per existing `Product` copying `Product.stock` → `stock`, `reservedAmount=0` via idempotent `InventorySeeder` (`onModuleInit`). Tolerates repeated runs after `Product.stock` is gone.
- New products auto-create inventory: `ProductsService.create` / `createMany` call `InventoryService.createForProduct(productId, initialStock)` (stock taken from `CreateProductInput.stock`, default 0). `ProductsModule` ↔ `InventoryModule` wired with `forwardRef` to resolve circular DI.
- Remove `stock` column and its `@Check('"stock" >= 0')` from `Product` entity.
- Redirect `InventoryService.decreaseStockForOrderMany` / `restoreStockForOrderMany` to operate on `Inventory` via `EntityManager`; add `getInventory`, `checkAvailability`, `increaseStock`, `decreaseStock`, plus stub `reserve` / `releaseReservation` / `completeSale` with correct math (locking in Phase 3).
- Thin REST controller at `/inventory` exposing reads and stock adjustments.

## Consequences

**Positive**
- Single source of truth for inventory; DB invariants enforce business rules.
- Later phases (reservation, concurrency, order integration) have a stable domain boundary (`InventoryService` only mutation point).
- Cart and order flows now go through `InventoryService.getInventory` / `checkAvailability`.

**Negative / Migration**
- Dev `synchronize: true` drops `Product.stock` on next boot after entity change; production MUST disable `synchronize` and add a real TypeORM migration (`up`: create `Inventory`, seed from `Product.stock`, drop `Product.stock`; `down`: restore). Never edit a committed migration.
- Existing code that read `product.stock` updated to use inventory; cached product listings no longer filter by `stock > 0`.

## Verification

- Unit: `inventory.service.spec.ts` asserts `Product` has no `stock` property and no code path reads it; service math & error cases.
- Integration (real PostgreSQL): `test/inventory.integration.spec.ts` asserts `Product` table has no `stock` column, `available` derived, `@Check` and uniqueness constraints enforced.
