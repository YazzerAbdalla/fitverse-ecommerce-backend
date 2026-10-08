# Feature Specification: Admin Product & Stock (Phase 20 Demo Scope)

**Feature Branch**: `019-admin-product-stock`
**Created**: 2026-10-08
**Status**: Draft
**Input**: User description: "phase 20 demo scope, reads and admin only role, and there is no user manipulation like admin can not add new co admin, just can update the stock and add new products and see the current products with searchs and filters and stock statuses like instock or out-stock and this status auto calculated, so plan file to mark this user stories as phase 20 demo scope and start the specification of this phase"
**Plan reference**: `docs/plan.md` Phase 20 (Dashboard, RBAC & Metrics). This spec narrows the Phase 20 **demo scope** to the user stories below; the full 5-role / 5-metric scope in `docs/plan.md` §§20.1–20.5 stays post-demo.

## Clarifications

### Session 2026-10-08

- Q: Low-stock threshold semantics → A: Fixed default of 5 units, overridable per request via a filter parameter.
- Q: Stock update shape → C: Signed delta only (no absolute-set mode).
- Q: Product with missing inventory row → B: List as out-of-stock with zero quantity.
- Q: Initial stock on product creation → A: Optional, defaults to zero when omitted.
- Q: Rate limiting on admin writes → A: Reuse the existing product-mutation throttle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View current products with stock status (Priority: P1) — PHASE 20 DEMO SCOPE

An admin views the current product catalog together with live stock information so they can see what is sellable right now. Each product row shows an auto-calculated stock status (`in-stock` / `out-of-stock`, plus `low-stock` warning) derived from current inventory, never stored or edited directly.

**Why this priority**: This is the demo's core read path. Without a trustworthy product + stock view, the update-stock and add-product stories have nothing to operate on or verify against.

**Independent Test**: Can be fully tested by signing in as an admin, opening the product list, and confirming every row shows current quantity and a correct auto-calculated status — delivers a working admin catalog view on its own.

**Acceptance Scenarios**:

1. **Given** an admin is signed in and products exist with various inventory levels, **When** the admin opens the product list, **Then** each product shows its current available quantity and status `in-stock` when available is above the low threshold, `low-stock` when at or below threshold but above zero, `out-of-stock` when zero.
2. **Given** an admin is signed in, **When** the admin searches by product name (partial, case-insensitive), **Then** only matching products are returned with their correct stock statuses.
3. **Given** an admin is signed in, **When** the admin filters by stock status (`in-stock`, `low-stock`, `out-of-stock`) or by price range, **Then** only products satisfying all supplied filters are returned, paginated with total counts.
4. **Given** a non-admin (customer) signed-in user, **When** they attempt to open the admin product list, **Then** access is denied (forbidden) and no product cost/stock internals beyond the public catalog leak.

---

### User Story 2 - Add a new product with initial stock (Priority: P1) — PHASE 20 DEMO SCOPE

An admin adds a new product (name, description, price) with an initial stock quantity so it becomes sellable immediately after creation.

**Why this priority**: Demo must show catalog growth end-to-end (create → appears in list with `in-stock`/`out-of-stock` → customer can find it). Equal priority with viewing because a read-only demo proves nothing actionable.

**Independent Test**: Can be fully tested by creating one product as admin and then finding it in the admin list with the expected stock status — delivers a new sellable product on its own.

**Acceptance Scenarios**:

1. **Given** an admin is signed in, **When** the admin creates a product with a valid name, price, and initial stock, **Then** the product is created, its inventory is initialized to that stock, and it appears in the product list with the matching auto-calculated status.
2. **Given** an admin is signed in, **When** the admin creates a product with zero initial stock or omits stock entirely, **Then** the product is created with zero stock and listed as `out-of-stock`.
3. **Given** an admin is signed in, **When** the admin submits a duplicate product name, a negative price, or a negative stock quantity, **Then** the request is rejected with a clear validation/conflict error and nothing is created.
4. **Given** a non-admin user, **When** they attempt to create a product, **Then** access is denied.

---

### User Story 3 - Update stock for an existing product (Priority: P2) — PHASE 20 DEMO SCOPE

An admin corrects or replenishes stock for an existing product by applying a signed adjustment (delta) so the catalog reflects physical reality. Reserved units held by open reservations are never edited directly; only on-hand stock changes, and the status recalculates automatically.

**Why this priority**: Stock correction is the daily admin operation the demo must show, but it depends on the product list (US1) existing first, so P2.

**Independent Test**: Can be fully tested by changing one product's stock as admin and re-reading the list to see the new quantity and recalculated status — delivers corrected availability on its own.

**Acceptance Scenarios**:

1. **Given** an admin is signed in and a product exists, **When** the admin applies a positive stock adjustment, **Then** the stored stock increases by that amount, available quantity and status recalculate, and the new values are returned.
2. **Given** an admin is signed in, **When** the admin applies a negative stock adjustment that keeps stock at or above reserved units and at or above zero, **Then** the adjustment is applied and the status recalculates.
3. **Given** an admin is signed in, **When** the admin attempts to set stock below the currently reserved quantity or below zero, **Then** the request is rejected with a conflict error and stock is unchanged.
4. **Given** a non-admin user, **When** they attempt to update stock, **Then** access is denied.

---

### User Story 4 - Explicitly OUT OF demo scope: user/role manipulation (Priority: P3 — deferred post-demo)

No admin user-management capability ships in the demo. There is no role upgrade/downgrade, no new roles (CoAdmin / ContentManager / FulfillmentStaff), no user creation/deletion by admins, and no self-demotion guard to implement — because the endpoints do not exist in demo scope.

**Why this priority**: Listed only to lock the boundary. It protects the demo from scope creep and records the deferred full-scope RBAC work.

**Independent Test**: Can be tested by verifying that no user-role management capability is exposed to any caller in the demo (attempts fail as unknown/forbidden) — delivers a locked, auditable scope boundary.

**Acceptance Scenarios**:

1. **Given** any signed-in user including an admin, **When** they attempt to change any user's role or manage users as an admin, **Then** no such capability exists in the demo scope.
2. **Given** the demo scope review, **When** the full Phase 20 role hierarchy is considered, **Then** it is explicitly recorded as post-demo with no demo behavior depending on it.

---

### Edge Cases

- What happens when two admins update the same product's stock at the same time? Last-writer-wins per write (lock-free delegates, REFACTOR_PLAN B-3); the loser sees current state on re-read and no reserved units are lost or double-counted (guards re-checked per write; tests assert guards-intact, never an exact final stock).
- How does the system handle a product whose inventory row is missing? The product still lists as `out-of-stock` with zero available quantity — no separate flag, no error. A positive stock adjustment auto-creates the row (`createForProduct` then increase); a negative adjustment on a missing row returns `404`.
- What happens when a search/filter combination matches nothing? An empty list with correct pagination totals is returned (not an error).
- What happens when stock is updated while reservations hold units? Available quantity and status recalculate from the new stock minus unchanged reserved units; held units are never released by a stock edit.
- How does the system handle invalid pagination (page 0, huge limit)? Request is rejected or safely clamped with documented bounds (`page >= 1`, `1 <= limit <= 100`).
- How are search wildcards handled? `%`, `_`, `\` in `search` are escaped before `ILIKE` (a search for `%` matches a literal percent, not everything); `search` is capped at 100 chars.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (DEMO)**: System MUST let an admin view a paginated list of current products, where each entry shows current available quantity and an auto-calculated stock status.
- **FR-002 (DEMO)**: System MUST auto-calculate stock status per product as `out-of-stock` when available is zero, `low-stock` when available is above zero but at or below the low-stock threshold, `in-stock` otherwise. The threshold defaults to 5 units and MAY be overridden per list request via a filter parameter; it is never persisted per product. Status MUST be derived on read, never stored or accepted from the client.
- **FR-003 (DEMO)**: System MUST compute available quantity as on-hand stock minus reserved units held by open reservations. A product with no inventory row MUST list with zero available quantity (`out-of-stock`).
- **FR-004 (DEMO)**: System MUST support admin product-list search by name (partial, case-insensitive) combined with filters for stock status and price range, plus pagination with total counts.
- **FR-005 (DEMO)**: System MUST let an admin create a new product with name, description, price, and optional initial stock in a single operation (omitted stock defaults to zero); the product MUST appear in the list immediately with the correct status.
- **FR-006 (DEMO)**: System MUST reject product creation with a duplicate name, negative price, or negative stock, creating nothing.
- **FR-007 (DEMO)**: System MUST let an admin update stock for an existing product as a signed adjustment (delta: positive to add, negative to subtract).
- **FR-008 (DEMO)**: System MUST reject any stock update that would leave on-hand stock negative or below currently reserved units, leaving stock unchanged.
- **FR-009 (DEMO)**: System MUST restrict all stock-mutation paths to the admin role — the new dashboard routes (product list, product creation, stock update) AND the legacy `POST /inventory/:productId/increase|decrease` (tightened to `@Auth(Admin)` in this spec, T002b); non-admin callers MUST be denied on every path. Reads (`GET /inventory/:productId`, `/availability`) stay any-role.
- **FR-010 (DEMO)**: System MUST NOT expose any user/role management capability in demo scope (no role changes, no new roles, no admin user CRUD).
- **FR-011 (DEMO)**: System MUST re-validate all client-supplied quantities and prices on the server and never trust client-computed availability or status.
- **FR-013 (DEMO)**: System MUST apply the existing product-mutation rate limit numbers (30/h per admin) to product creation and stock updates as separate per-route counters (not a shared bucket; excess requests denied without touching inventory). The admin list read is explicitly unthrottled (recorded exemption, consistent with existing `GET` policy).
- **FR-012 (POST-DEMO, explicitly deferred)**: Full Phase 20 RBAC (new roles, role upgrade/downgrade, last-admin guard), order/cart admin reads, bulk stock writes, and dashboard metrics (revenue, average order value, abandonment, API health) MUST remain out of demo scope.

### Key Entities

- **Product**: Sellable catalog entry — name (unique), description, price (never negative). Gains no stock column of its own in this scope.
- **Inventory**: Per-product stock truth — on-hand stock, reserved units (held by open reservations, never directly editable by admins), available quantity derived as stock minus reserved.
- **StockStatus**: Derived read-only label per product — `in-stock` / `low-stock` / `out-of-stock`, computed from available quantity against the low-stock threshold.
- **Admin**: The only actor in demo scope — existing admin role, no new roles, no user-management powers in this spec.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can find any product by name search and see its correct stock status within 5 seconds of opening the list.
- **SC-002**: 100% of product rows show a stock status consistent with their available quantity (zero audit mismatches between displayed status and stock-minus-reserved math).
- **SC-003**: An admin can add a new product and see it listed with the correct status in under 1 minute, with zero duplicate-name products created.
- **SC-004**: 100% of stock updates that would drop stock below reserved units or below zero are rejected with stock left unchanged.
- **SC-005**: 100% of non-admin attempts to use admin product/stock capabilities are denied, and 100% of role-management attempts find no such demo capability.

## Assumptions

- Existing admin/customer roles are reused; no role model change ships in the demo.
- Existing product and inventory records (including seeded data) are the demo dataset; no data migration is needed for the demo.
- The low-stock threshold defaults to 5 units and is adjustable per list request via a filter parameter; no persisted per-product threshold ships in the demo.
- Product detail edits beyond stock (rename, reprice, delete) and bulk stock operations are post-demo unless trivially included without expanding scope.
- Customer-facing catalog behavior is unchanged by this spec; only the admin view gains stock statuses and write powers.
- Standard pagination bounds apply (e.g., page starts at 1, limit capped at a documented maximum).
