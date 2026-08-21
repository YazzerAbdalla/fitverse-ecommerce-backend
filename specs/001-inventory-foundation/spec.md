# Feature Specification: Inventory Foundation

**Feature ID**: 001-inventory-foundation
**Phase**: Phase 1 — Inventory Foundation (per `docs/plan.md`)
**Status**: Draft (ready for `/speckit.clarify` / `/speckit.plan`)
**Source**: `docs/plan.md` Phase 1 + reconciliation of existing `Product.stock` code

---

## 1. Overview

Today the application tracks product stock directly on the `Product` entity
(`Product.stock`), and `InventoryService` mutates that column. This violates the
established architectural decision in `docs/plan.md` Phase 0:

> *Product does not own inventory state*
> *Inventory is a separate domain*
> *PostgreSQL is the transactional source of truth*

This feature introduces **Inventory** as a first-class domain that owns the
authoritative stock and reservation counters for each product. It establishes a
clean boundary that later phases (Reservation, Order, Concurrency) can depend on.
No reservations are implemented in this phase.

### Goal

Establish an Inventory domain with database-enforced invariants and business
operations, and reconcile the existing `Product.stock` field so inventory state
lives only in the Inventory domain.

---

## Clarifications

### Session 2026-08-21

- Q: How should we reconcile the existing `Product.stock` column? → A: Remove `Product.stock` entirely; Inventory is the sole owner of stock (confirmed via `/speckit.clarify`).
- Q: How is an `Inventory` record first created for a product? → A: Auto-create on Product creation with initial stock from input (default 0); additionally seed Inventory from existing `Product.stock` values via a data migration before the `Product.stock` column is dropped (confirmed via `/speckit.clarify`).

---

## 2. User Scenarios

### Scenario A — Inventory is created for a product
A system/operator creates an inventory record for a product with an initial
stock level. The system stores `stock`, `reserved_amount` (defaults to 0), and
timestamps, and links it to exactly one product.

### Scenario B — Available quantity is calculated
A caller asks how many units are available for a product. The system returns
`available = stock - reserved_amount` without persisting a separate available
field.

### Scenario C — Invalid inventory state is rejected
A write that would make `stock < 0`, `reserved_amount < 0`, or
`reserved_amount > stock` is rejected by the database and surfaced as an error.

### Scenario D — Other modules use business operations
The Order module (and later Reservation) performs stock changes through
Inventory business operations, never by writing the inventory/stock columns
directly.

### Scenario E — Existing Product.stock is reconciled
The `Product.stock` column is removed (or made non-authoritative) so that the
single source of truth for stock is the Inventory record. Existing code paths
that read/write `Product.stock` are updated to use the Inventory domain.

---

## 3. Functional Requirements

### FR1 — Inventory entity
The system SHALL provide an Inventory record with the following data:
- `id` (unique identifier)
- `product_id` (reference to a Product)
- `stock` (current physical stock, integer)
- `reserved_amount` (quantity temporarily reserved, integer)
- `created_at`
- `updated_at`

### FR2 — Database-enforced invariants
The database SHALL enforce:
- `stock >= 0`
- `reserved_amount >= 0`
- `reserved_amount <= stock`

### FR3 — One inventory per product
Each product SHALL have at most one inventory record. The `product_id` reference
SHALL be unique, and the relationship between Product and Inventory SHALL be
one-to-one (Inventory owns the reference to Product).

### FR4 — Available is derived, not stored
The system SHALL compute `available = stock - reserved_amount` on demand. The
system SHALL NOT store `available` as an independently mutable field.

### FR5 — Inventory module and service boundary
The system SHALL expose Inventory through a dedicated module and service that
provide business operations (e.g. get inventory, check availability, increase
stock, decrease stock, reserve, release reservation, complete sale). Other
modules SHALL call these operations and SHALL NOT mutate inventory columns
directly.

### FR6 — Reconcile existing `Product.stock`
The system SHALL relocate inventory state away from `Product`:
- **Seed**: Before dropping the column, run a one-time data migration that
  creates an `Inventory` record for every existing `Product`, copying each
  product's current `stock` value into `Inventory.stock` (with `reserved_amount = 0`).
- **Remove**: Drop the `stock` column from the `Product` entity so Inventory is
  the sole owner of stock.
- **Redirect**: Update `InventoryService` (currently operating on `Product.stock`
  via `decreaseStockForOrderMany` / `restoreStockForOrderMany`) to operate on the
  Inventory entity instead.
- **Auto-create**: Whenever a new `Product` is created, an `Inventory` record is
  created automatically with initial `stock` taken from the product creation
  input (defaulting to 0).

### FR7 — Tests
The system SHALL have tests verifying: inventory creation, reading inventory,
available calculation, rejection of negative stock, rejection of invalid
reserved amount, and prevention of an invalid inventory state.

---

## 4. Success Criteria

- **SC1**: Every product's inventory state is stored only in the Inventory
  domain; `Product.stock` is no longer the source of truth (verified by code
  review and tests).
- **SC2**: The database rejects any write producing `stock < 0`,
  `reserved_amount < 0`, or `reserved_amount > stock` (verified by a failing
  write test).
- **SC3**: `available` is always equal to `stock - reserved_amount` as observed
  through the business API.
- **SC4**: Two different products cannot share an inventory record, and one
  product cannot have two inventory records (unique constraint enforced).
- **SC5**: At least one automated test exists for each functional requirement
  in FR7, and all pass.

---

## 5. Key Entities

### Inventory
| Field | Type | Notes |
| --- | --- | --- |
| id | identifier | Primary key |
| product_id | reference | Unique; one-to-one with Product |
| stock | integer | `>= 0` |
| reserved_amount | integer | `>= 0` and `<= stock` |
| created_at | timestamp | |
| updated_at | timestamp | |

Relationship: `Inventory` → (one) `Product`. `Product` does not own inventory
state.

---

## 6. Dependencies

- `docs/plan.md` Phase 0 architectural decisions (Product/inventory separation,
  PostgreSQL as source of truth).
- Existing `Product` entity (`src/modules/products/entities/product.entity.ts`)
  currently carries a `stock` column that must be reconciled.
- Existing `InventoryService`
  (`src/modules/inventory/inventory.service.ts`) currently mutates
  `Product.stock`; it must be redirected to the Inventory entity.
- `InventoryModule` already exists but only provides `InventoryService` with no
  entity or controller; it will be extended.

---

## 7. Assumptions

- **A1 (Product.stock reconciliation)**: DECIDED — the `stock` column will be
  **removed** from `Product` (confirmed 2026-08-21). Inventory is the sole owner
  of `stock`. All reads/writes of product stock now go through the Inventory
  domain. No read-only mirror is kept (avoids a second source of truth).
- **A2**: `reserved_amount` starts at 0 for new inventory; reservations are a
  later phase, but the field and constraint are introduced now.
- **A3**: Business operation names (reserve, release, completeSale, etc.) follow
  existing project conventions; exact method names are finalized in the design
  phase.
- **A4**: Synchronize is currently `true` in dev; the new entity will be picked
  up by the ORM. Real migrations are introduced before production (per AGENTS.md).
- **A5**: No new infrastructure (Redis/RabbitMQ) is introduced in this phase.

---

## 8. Out of Scope (this phase)

- Reservation entities and state machine (Phase 2).
- Transaction-safe / row-locking reservation (Phase 3).
- Reservation lifecycle transitions (Phase 4).
- Expiration cleanup worker (Phase 5).
- Order integration (Phase 6+).

---

## 9. Acceptance Scenarios (for planning)

1. Creating inventory for a product with `stock = 10` yields
   `reserved_amount = 0`, `available = 10`.
2. Attempting to set `stock = -1` is rejected.
3. Attempting `reserved_amount = 5` when `stock = 3` is rejected.
4. Two inventory records cannot reference the same product.
5. After removing `Product.stock`, no code path reads/writes `Product.stock` as
   the source of truth.
