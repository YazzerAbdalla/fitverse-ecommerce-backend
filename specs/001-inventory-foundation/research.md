# Research: Inventory Foundation (Phase 1)

**Feature**: 001-inventory-foundation
**Date**: 2026-08-21
**Goal**: Resolve open decisions and confirm best-practice approaches for the Inventory entity, the `Product.stock` reconciliation, and the module/service boundary.

---

## R1 — Reconcile `Product.stock`

- **Decision**: Remove the `stock` column from `Product`. `Inventory` becomes the sole owner of `stock` and `reserved_amount`.
- **Rationale**: The constitution (Principle III) and `docs/plan.md` Phase 0 both state "Product does not own inventory state." Keeping a column on `Product` creates a second source of truth that can drift and undermines the inventory/reservation design in later phases.
- **Alternatives considered**:
  - Keep `Product.stock` as a read-only mirror — rejected; risks drift and contradicts Principle I (PostgreSQL single source of truth for inventory).
  - Keep `Product.stock` authoritative, `Inventory` only tracks `reserved_amount` — rejected; directly contradicts the Phase 0 decision.
- **Implied work**: A one-time seeding step must copy each existing `Product.stock` into a new `Inventory` row before the column is dropped.

## R2 — How an `Inventory` record is created

- **Decision**: Auto-create an `Inventory` record when a `Product` is created, with initial `stock` taken from product-creation input (default 0). Seed existing products from their current `stock` during migration.
- **Rationale**: Guarantees every product has inventory, so availability checks never hit a missing row and later reservation code has a stable target. Matches the clarification answer.
- **Alternatives considered**:
  - Explicit-only creation endpoint — rejected; leaves products without inventory until manually provisioned, complicating later phases.
  - Lazy-create on first stock op — rejected; adds null-lookup branches throughout the codebase.

## R3 — Relationship shape (Product ↔ Inventory)

- **Decision**: One-to-one, `Inventory` owns the FK (`@OneToOne` on `Inventory` side with `@JoinColumn`, referencing `Product`). `product_id` is `@Unique`.
- **Rationale**: Exactly one inventory record per product (spec FR3). `Inventory` is the dependent side that holds the reference; `Product` stays free of inventory state.
- **TypeORM specifics**: `@PrimaryGeneratedColumn('uuid')` PK; `@ManyToOne`/`@OneToOne` with `@JoinColumn` on owning side per AGENTS.md Database Rules. Use `@Index()` on `product_id` (access pattern from `docs/plan.md` §13).

## R4 — Invariants and `available`

- **Decision**: Enforce `stock >= 0`, `reserved_amount >= 0`, `reserved_amount <= stock` via `@Check` decorators (DB-level, like `Product`'s existing `@Check('"stock" >= 0')`). Expose `available` as a non-persisted getter/`@VirtualColumn` returning `stock - reserved_amount`; never a stored mutable column.
- **Rationale**: Constitution Principle III mandates the DB enforce these and forbids storing `available` as an independently mutable column.
- **TypeORM specifics**: `@Check('"stock" >= 0')`, `@Check('"reserved_amount" >= 0')`, `@Check('"reserved_amount" <= stock')`. Getter avoids an extra column.

## R5 — Module boundary & service API

- **Decision**: `InventoryModule` imports `ProductsModule`, provides and **exports** `InventoryService`. Other modules (order, later reservation) call `InventoryService` methods; they must not `@InjectRepository(Inventory)`. Controller is thin.
- **Rationale**: Constitution Principles II & V. Reuses the existing `InventoryService` rather than inventing a new one.
- **Business operations** (names follow existing `decreaseStockForOrderMany`/`restoreStockForOrderMany` style): `getInventory(productId)`, `checkAvailability(productId, qty)`, `increaseStock(productId, qty)`, `decreaseStock(productId, qty)`, `reserve(productId, qty)`, `releaseReservation(productId, qty)`, `completeSale(productId, qty)`. Phase 1 implements the read/stock ops; reserve/release/completeSale are stubbed with correct inventory math but wired into transactions in Phase 3/4.

## R6 — Seeding & migration strategy

- **Decision (dev, `synchronize: true`)**: Add an `InventorySeeder` (run via `onModuleInit` in `InventoryModule`, guarded to run once / idempotent) that, for every `Product`, creates an `Inventory` row copying `Product.stock` into `stock` with `reserved_amount = 0`. Run this while `Product.stock` still exists. Only afterward remove `Product.stock`.
- **Decision (production)**: Constitution Additional Constraints require disabling `synchronize` and adding a real TypeORM migration before prod. The migration `up` creates the `Inventory` table, seeds from `Product.stock`, then drops `Product.stock`; `down` restores `Product.stock` from `Inventory`. Never edit a committed migration — add a new one.
- **Rationale**: Keeps dev fast while honoring the constitution's migration rule; seeding-before-drop order prevents data loss.

## R7 — Testing approach

- **Decision**: Unit tests mock the repository/`ProductsService`; integration tests run against a **real PostgreSQL** and assert the `@Check` constraints reject invalid writes and that `available` is derived correctly. Per constitution Principle VII, the DB is never mocked for consistency/constraint tests.
- **Rationale**: Constraints and derived `available` are DB/entity behavior; only a real DB validates them.

---

## Open items resolved

| From spec | Resolution |
| --- | --- |
| Product.stock reconciliation (A1) | Remove column; Inventory owns stock |
| Inventory creation model (Q2) | Auto-create on Product creation + seed existing |

No remaining `NEEDS CLARIFICATION` markers.
