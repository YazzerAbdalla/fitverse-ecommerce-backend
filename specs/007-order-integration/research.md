# Research — Order Integration — Checkout-Only Reservation Refactor (Phase 6)

**Branch**: `007-order-integration` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` in Technical Context were `none` (stack: NestJS 11, TypeScript 5, PostgreSQL 17 + TypeORM, Redis 8, RabbitMQ 4, Jest). Spec Sessions 2026-09-21 resolved 9 business clarifications (Q1 cart-only A, Q2 reservation atomic A, Q3 productId A, Q4 enum A, Q5 defer B, plus directive checkout-only + Q6 POST block User/keep Admin A, Q7 PATCH restrict B, Q8 Order auto-CANCELLED on expiry B, Q9 GET reservationId-only A). No new external tech beyond TypeORM migration, `FOR UPDATE` pattern, and guard changes. Decisions below shape Phase 0.

---

## D1 — Remove manual `POST /reservations` for User role (checkout-only reservation) — directive 2026-09-21

- **Decision**: Make `Reservation` creation **checkout-only** for users. Refactor `src/modules/reservation/reservation.controller.ts:23` `@Post()` from `@Auth(User,Admin)` to either **(a) deleted** (returns `404`) or **(b) `@Auth(Admin)` + explicit `403` for `User`** with message `Reservation can only be created via POST /order/checkout`. Service method `ReservationService.create(manager,userId,dto)` is renamed/refactored to **`createForCheckout(manager, userId, items: {inventoryId,quantity}[], orderId: string)`** internal — not exposed via HTTP for User. `OrderCheckoutService` inside `dataSource.transaction` calls `createForCheckout` using the same `manager` and already-locked `Inventory` rows. `POST /reservations` for Admin may stay for testing/worker but is not the user path.

- **Rationale**: Today's manual endpoint lets any `User` reserve arbitrary `inventoryId`s outside cart context, creating **two producers** of `Increment reservedAmount` (manual `ReservationService.create` and checkout `OrderCheckoutService`). Even though both use `FOR UPDATE` sorted locking, the dual path doubles the single-winner test matrix (manual vs checkout vs checkout vs checkout), allows phantom holds that bypass cart's `available` optimistic check, and duplicates `available >= requested` validation in two places. Single path (`OrderCheckoutService` is the sole increment site) eliminates the manual-checkout race class, reduces API surface, and matches `docs/plan.md` §6.4 decision **C. When order is created** and spec `FR-005:124` (cart never mutates inventory). Constitution IV single-winner then collapses to checkout-vs-checkout only, which is already single-winner via `FOR UPDATE`.

- **Alternatives considered**: (a) Keep both paths but add extra guard — e.g., `POST /reservations` checks cart equality (`reservation items ⊆ cart items`) → rejected: still 2 producers, adds TOCTOU (cart may change between `POST /reservations` and `POST /order/checkout`), doubles branches and tests. (b) Keep `POST /reservations` `@Auth(User,Admin)` but document “prefer checkout” → rejected: users can still bypass, race remains, violates user directive. (c) Delete controller method entirely (no HTTP) → acceptable but then `POST` returns `404` not `403`; either is fine, but `403` is more explicit for users who cached the old contract and explains migration. Chosen: **remove for User, return `403`** (or `410 Gone`) with clear message; keep `createForCheckout` internal and `GET`/`PATCH` routes unchanged for read/cancel/expire.

- **Impact**: Existing tests that `POST /reservations` as User must be updated to expect `403` (or to use `POST /order/checkout`); admin/worker tests keep passing. No PG schema change.

## D2 — Checkout-only internal API is `createForCheckout(manager,userId,items,orderId)` reusing same locked rows

- **Decision**: Define `ReservationService.createForCheckout(manager: EntityManager, userId: string, items: {inventoryId:string, quantity:number}[], orderId: string): Promise<Reservation>` that:
  1. Assumes caller already holds `FOR UPDATE` on all `inventoryId`s in sorted order (no re-lock).
  2. Validates `items.length>0`, `quantity>0`, no duplicate `inventoryId` (same checks as `create`).
  3. Creates `Reservation {userId, orderId, status:RESERVED, expiresAt: now+15m}` + `ReservationItem[]` via `manager`.

- **Rationale**: Reuses Phase 3-4 invariant checks but avoids double-locking `Inventory` rows. Keeps DRY — checkout and manual (if kept for Admin) share validation but checkout is the sole caller in V1. Smallest change: rename `create` to `createForCheckout` or keep `create` but make controller not call it for User; add `createForCheckout` wrapper. Keeps `validateTransition`/`assertOwner` untouched.

- **Alternatives considered**: (a) Duplicate `reservedAmount+=qty` logic in `OrderCheckoutService` → rejected: would duplicate quantity validation and unique constraint handling. (b) Keep `create(dto)` signature and pass `orderId` via `dto.orderId` → rejected: dto already has `orderId` optional, but checkout should not accept client-supplied `orderId` (server-generated). Explicit `orderId` param is clearer and prevents client injection.

## D3 — Checkout transaction reuses Phase 3-4 `FOR UPDATE` sorted pattern

- **Decision**: `OrderCheckoutService.checkout(userId)` runs `dataSource.transaction(async manager => { ... })` with steps `spec.md:108` FR-003: load `Cart`+`CartItems`+`Product` via `manager`, map `productIds→inventoryIds`, `sortedIds = [...new Set(ids)].sort()`, `SELECT ... FOR UPDATE` Inventories, check `available >= requested`, increment `reservedAmount`, create `Order` + `OrderItems` (snapshot `Product.price`), call `createForCheckout(manager,userId,items,order.id)` without re-lock, clear cart via `CartService.clearCartForCheckout(manager,userId)`.

- **Rationale**: Same deterministic ordering prevents deadlocks `[A,B]` vs `[B,A]` and keeps lock window short (no external I/O). Proven in Phase 3 `reservation.service.ts:81` and Phase 5 `data-model.md:115`. Transaction is the sole place that increments `reservedAmount` after refactor, so correctness is centralized.

- **Alternatives considered**: (a) Lock via `InventoryService.reserve()` helper that does its own `getInventory` → rejected: that helper does `findOne` without `FOR UPDATE`, not safe for checkout race. (b) `SELECT ... FOR UPDATE` on `Product` as well → rejected: price snapshot does not need pessimistic lock; read-committed is sufficient unless price races are proven business-critical (defer).

## D4 — Concurrency guarantee is checkout-vs-checkout single-winner via `FOR UPDATE`

- **Decision**: After removal of manual `POST`, the only contended writer of `Inventory.reservedAmount` is `OrderCheckoutService.checkout`. Two concurrent checkouts on `available=1` → first `COMMIT` increments `9→10`, second after acquiring `FOR UPDATE` sees `available=0 < requested=1` → `409`. Test via `Promise.all` with real `DataSource.transaction` `--runInBand`.

- **Rationale**: Eliminating manual path reduces single-winner verification from 3 combos (manual vs checkout, checkout vs checkout, manual vs manual) to 1 combo. Simpler to reason and faster to prove SC-003/SC-007.

- **Alternatives considered**: Keep manual path but add advisory lock in Redis → rejected: correctness must not depend on Redis (constitution I); DB `FOR UPDATE` is already authoritative.

## D5 — `OrderItem` FK is `productId → Product` RESTRICT, not `inventoryId` (Q3 Option A)

- **Decision**: `OrderItem.productId FK → Product.id ON DELETE RESTRICT`, `Unique(orderId,productId)`, snapshot `unit_price`. `Inventory` is derived via `Product` 1-1. No `inventoryId` column on `OrderItem` in V1.

- **Rationale**: Product is canonical for price/name history; inventory row is ephemeral stock holder. Coupling order history to inventory lifecycle risks `CASCADE` delete losing history. Q3 Option A.

- **Alternatives considered**: `inventoryId` only → rejected: would require `JOIN Inventory→Product` for price display and would couple history to inventory deletion.

## D6 — Enum migration is immediate (Q4 Option A)

- **Decision**: Migration `17xxxxx-OrderIntegrationCheckoutOnly` renames PG enum `OrderStatus` value `SUCCESS→COMPLETED`, `FAILD→FAILED`, adds `CANCELLED`/`FAILED` if missing, sets default `PENDING`. TypeScript `src/modules/order/order-status.enum.ts` updated to `PENDING|COMPLETED|CANCELLED|FAILED`. No alias kept; `CREATE TABLE` had no historic rows beyond seeds.

- **Rationale**: Fix typo before production; stub has no data loss risk. Q4 Option A.

- **Alternatives considered**: Code-only mapping `SUCCESS→COMPLETED` → rejected: hides DB typo.

## D7 — Checkout DTO is empty `CheckoutDto` with `forbidNonWhitelisted` (Q1 Option A)

- **Decision**: `src/modules/order/dto/checkout.dto.ts` is `class CheckoutDto {}` (no fields). Controller `POST /order/checkout` signature `(@CurrentUser('sub') userId)` with `@Body() _dto: CheckoutDto` — global `ValidationPipe` rejects any `items[]`, `reservationId`, `orderId` with `400`.

- **Rationale**: Enforces cart-only contract; prevents client-side `total` manipulation. Q1 Option A.

- **Alternatives considered**: `items?: {productId,quantity}[]` hybrid → rejected per Q1.

## D8 — Testing strategy: real PostgreSQL for checkout + 403 for blocked manual POST

- **Decision**: Unit mocks `EntityManager` for guards; integration on real PG for checkout atomicity, historical isolation, `409` rollback, `FOR UPDATE` single-winner, opposite-order deadlock, `EXPLAIN` row lock, and new test `POST /reservations` as User → `403` (or `404` if deleted). E2E `register→add to cart→checkout→GET /order→price mutation`.

- **Rationale**: Constitution VII mandates real PG for transactions/locking; `--runInBand` avoids Jest worker pollution (observed Phase 3). Blocking test proves refactor.

## D9 — Additional Phase 6 clarifications (Q6-Q9, second clarify 2026-09-21)

- **Q6/Q7 POST & PATCH restrict (B)**: `POST /reservations @Auth(Admin)` keeps `201` for Admin, User → `403 {message:"Use POST /order/checkout"}`; `PATCH /:id/complete|cancel` → `403` for User on checkout-created reservations (transitions via Order lifecycle Phases 7-8 or Admin/worker only; `GET` remains for owner/Admin, `expire` stays Admin). Prevents `Order PENDING` vs `Reservation CANCELLED` inconsistency and keeps `reservedAmount` single-producer.

- **Q8 Order auto-CANCELLED on expiry (B)**: Expiration worker transaction that marks `Reservation RESERVED→EXPIRED + reservedAmount-=qty` also sets `Order PENDING→CANCELLED` atomically in same `EntityManager` commit (lock Reservation `FOR UPDATE` → lock Inventories → update both). `FAILED` reserved for payment failures. Keeps Order/Reservation consistent without dangling `PENDING`. Alternative Q8 A (stay PENDING) rejected — would leave dangling orders requiring manual retry.

- **Q9 GET reservation shape (A)**: `GET /order/:id` and `GET /order` return `{..., reservationId, expiresAt}` link only, not embedded `Reservation` object; client fetches `GET /reservations/:id` for details. Keeps modular boundaries (OrderModule → ReservationModule via `orderId` FK, not eager join) and avoids data duplication.

- **Alternatives**: For Q8, stay PENDING → rejected (leaves dangling); for Q7, keep PATCH for User → rejected (allows direct complete without payment); for Q9, embed full reservation → rejected (JOIN explosion).

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking change: clients calling `POST /reservations` as User now get `403`/`404` | Return explicit `403` with message `Use POST /order/checkout` and document in `contracts/reservation-refactor.md` + `quickstart.md`; keep service method for Admin/internal tests if needed; update integration tests to expect `403` |
| `Order`/`OrderItem` `ManyToMany` → `OneToMany` migration loses join table `order_order_items_order_item` if it contains data | Migration drops spurious join table and adds `orderId` FK; Phase 6 has no historic orders (stub) so safe; document `synchronize:false` |
| Checkout transaction holds locks too long (Product reads + cart clear) | Keep tx short: only lock inventories, snapshot price via `manager.findOne(Product)` without lock, create `Order`/`OrderItem`/`Reservation` then `DELETE CartItem` — no RMQ/Redis inside tx |
| Duplicate product in cart (cart already normalizes but race) | D2 validates duplicate `inventoryId`; `Unique(orderId,productId)` DB backstop catches duplicate OrderItem |
| Price race: product price updated between read and commit | Read-committed snapshot is acceptable; second committer sees new price; no `FOR UPDATE` on Product needed unless proven |
| Parallel Jest workers pollute DB | `npm run test -- --runInBand` documented in `quickstart.md` |
