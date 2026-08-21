# Inventory Domain (Phase 1)

**Feature**: 001-inventory-foundation
**Status**: Implemented

## Overview

Inventory is a first-class domain that owns authoritative stock state for each Product. Product no longer carries a `stock` column; `Inventory` is the sole source of truth.

## Entity

`src/modules/inventory/entities/inventory.entity.ts`

| Field | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | PK, `PrimaryGeneratedColumn('uuid')` |
| `productId` | `uuid` | `Unique`, `Index`, FK → `Product.id`, owning side `@OneToOne` + `@JoinColumn` |
| `stock` | `int` | `Check(stock >=0)`, NOT NULL, default 0 |
| `reservedAmount` | `int` | `Check(reservedAmount >=0)`, `Check(reservedAmount <= stock)`, NOT NULL, default 0 |
| `createdAt` | `Date` | `CreateDateColumn` |
| `updatedAt` | `Date` | `UpdateDateColumn` |
| `available` | `int` (derived) | `stock - reservedAmount`, getter, never persisted |

Relations:
- `Inventory` → `Product` (`@OneToOne`, owning)
- `Product` → `Inventory` (inverse, read-only)

## Business API

`InventoryService` is the only place that mutates inventory columns.

| Method | Purpose |
| --- | --- |
| `createForProduct(productId, initialStock)` | Auto-create on product creation (idempotent) |
| `getInventory(productId)` | Fetch or `NotFoundException` |
| `checkAvailability(productId, qty)` | Returns `available >= qty` |
| `increaseStock(productId, qty)` | `stock += qty` |
| `decreaseStock(productId, qty)` | `stock -= qty`, `ConflictException` if would violate `stock >=0` or `reservedAmount <= stock` |
| `decreaseStockForOrderMany(manager, items)` | Bulk `stock -= soldQuantity` via `EntityManager` (caller-owned transaction) |
| `restoreStockForOrderMany(manager, items)` | Bulk restore |
| `reserve(productId, qty)` | `reservedAmount += qty` (stubbed, wired in Phase 3) |
| `releaseReservation(productId, qty)` | `reservedAmount -= qty` |
| `completeSale(productId, qty)` | `stock -= qty; reservedAmount -= qty` |

All quantity args validated `@IsInt() @Min(1)` at DTO layer, re-checked in service.

## Seeding & Auto-creation

- `InventorySeeder` (idempotent, `onModuleInit` in `InventoryModule`) copies `Product.stock` → `Inventory.stock` for existing products, `reservedAmount=0`. Tolerates already-removed `Product.stock` column.
- `ProductsService.create` / `createMany` call `InventoryService.createForProduct` after saving the product. Initial stock taken from the GraphQL `CreateProductInput.stock` (default 0).

Order of operations on `synchronize: true` dev: seed runs while `Product.stock` still exists; entity change then drops the column on next sync. Production note: before prod, disable `synchronize` and add a real TypeORM migration (create `Inventory`, seed, drop `Product.stock`).

## REST API

Base `/inventory`, protected by `@Auth()` (`JwtGuard`+`RolesGuard`), thin controller delegating to service.

| Method | Path | Body / Query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/inventory/:productId` | — | 200 inventory with `available` | 404 not found |
| GET | `/inventory/:productId/availability?quantity=q` | `quantity` int >=1 | 200 `{ available, requested, sufficient }` | 400 invalid, 404 not found |
| POST | `/inventory/:productId/increase` | `{ quantity }` | 200 updated inventory | 400 invalid, 404 not found |
| POST | `/inventory/:productId/decrease` | `{ quantity }` | 200 updated inventory | 400 invalid, 404 not found, 409 insufficient stock |

DTOs: `IncreaseStockDto` / `DecreaseStockDto` (`quantity: number`, `@IsInt() @Min(1)`).

## Constraints & Invariants

DB-enforced via `@Check` and `@Unique`:
- `stock >=0`
- `reservedAmount >=0`
- `reservedAmount <= stock`
- one inventory per product

`available` never stored; always `stock - reservedAmount`.

## Module Wiring

- `InventoryModule` imports `TypeOrmModule.forFeature([Inventory])` and `forwardRef(() => ProductsModule)`, provides `InventoryService` + `InventorySeeder`, exports `InventoryService`, registers `InventoryController`.
- `ProductsModule` imports `forwardRef(() => InventoryModule)` to allow `ProductsService` → `InventoryService` auto-creation.

Other modules must call `InventoryService`, never `@InjectRepository(Inventory)`.

## Testing

- Unit: `inventory.service.spec.ts` mocks repository & `ProductsService`; covers math, errors, `Product.stock` absence, `available` getter.
- Integration: `test/inventory.integration.spec.ts` against real PostgreSQL; asserts `@Check` rejections, uniqueness, `available` derivation, missing `Product.stock` column.
