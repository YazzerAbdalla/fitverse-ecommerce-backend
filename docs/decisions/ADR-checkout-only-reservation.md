# ADR — Checkout-Only Reservation Refactor (Phase 6)

**Date:** 2026-09-21
**Status:** Accepted
**Spec:** `specs/007-order-integration/spec.md` + `plan.md` + `research.md` D1-D9
**Branch:** `007-order-integration`

## Context

Phases 2-5 allowed any authenticated `User` to `POST /reservations` with arbitrary `inventoryId`s outside cart context, creating two producers of `Inventory.reservedAmount` increment:
- Manual `ReservationService.create` (user-initiated)
- Checkout `OrderCheckoutService` (cart-initiated, to be added in Phase 6)

Both use `FOR UPDATE` sorted locking, but dual path doubles API surface, test matrix (manual vs checkout vs checkout vs checkout), and allows phantom holds that bypass cart's optimistic `available` check. `docs/plan.md` §6.4 decision was unresolved; spec Session 2026-09-21 reaffirms **C. When order is created**.

User directive 2026-09-21: refactor reservation to be checkout-only for users.

## Decision

1. **Remove `POST /reservations` for `User` role** — controller `@Post()` now `@Auth(Admin,User)` but immediately `403 {message:"Reservation can only be created via POST /order/checkout"}` if `role !== Admin`. Alternative considered: delete route entirely → `404`; chosen `403` is more explicit for cached clients. `GET /:id`, `GET /`, `PATCH /:id/expire` remain; `PATCH /:id/complete|cancel` now `403` for `User` (Q7 B) — transitions via Order lifecycle Phases 7-8 or Admin/worker only.

2. **Internalize reservation creation as `createForCheckout(manager, userId, items, orderId)`** — assumes caller already holds `FOR UPDATE` on `sortedIds`, validates `quantity>0` + duplicate `inventoryId`, creates `Reservation RESERVED expiresAt now+15m orderId` + `ReservationItem`s via same `manager` without re-lock. Keeps validation DRY, eliminates double-lock.

3. **Cart-only `POST /order/checkout` (`CheckoutDto {}` empty, `forbidNonWhitelisted`)** — server loads `Cart+CartItems+Product` via `manager`, maps `productId→inventoryId`, `sortedIds` deterministic, `FOR UPDATE` inventories, `available = stock - reservedAmount` check, `reservedAmount+=qty`, snapshot `Product.price`, create `Order PENDING total=Σ qty*price` + `OrderItem`s + `createForCheckout` + `clearCartForCheckout(manager)` in one `DataSource.transaction`. No Redis/RMQ I/O inside tx. `POST /order` alias kept deprecated.

4. **Order auto-cancel on expiry (Q8 B)** — expiration worker transaction that marks `Reservation RESERVED→EXPIRED` + `reservedAmount-=qty` also locks `Order FOR UPDATE` and sets `Order PENDING→CANCELLED` atomically same commit. Failure rolls back both; `FAILED` reserved for payment.

5. **Read contract Q9 A** — `GET /order/:id` and `GET /order` return `{..., reservationId, expiresAt}` link only, not embedded reservation, via `Reservation` lookup by `orderId` FK.

## Consequences

- **Positive:** Single producer of `reservedAmount` (checkout) → constitution IV single-winner collapses to checkout-vs-checkout only, simpler to prove SC-003/SC-007; eliminates manual-checkout race class; cart validation and inventory reservation unified.
- **Negative:** Breaking change — existing clients calling `POST /reservations` as User now get `403`/`404`; update integration tests to expect `403` and migrate to `POST /order/checkout`.
- **Schema:** No new Reservation columns; `Order`/`OrderItem` fix requires migration `1755900000002-OrderIntegrationCheckoutOnly` (drop join table, enum rename, FKs, checks, indexes).
- **Tests:** Real-PG integration required: checkout atomic, historical price, `409` rollback, `FOR UPDATE` single-winner checkout vs checkout, opposite-order deadlock, `EXPLAIN` row lock, `POST /reservations` as User→`403`, Order auto-cancel on expiry.

## Alternatives Rejected

- Keep both paths + add cart-equality guard on `POST /reservations` → still 2 producers, TOCTOU.
- Keep `@Auth(User,Admin)` but document “prefer checkout” → users can bypass.
- Duplicate `reservedAmount` logic in `OrderCheckoutService` → duplicates validation, violates DRY.
- Order stay `PENDING` on expiry (Q8 A) → leaves dangling orders.

## Verification

- `npm run build` + `npm run test -- --runInBand src/modules/order` pass (smoke).
- Manual `curl POST /reservations` as User→`403`, as Admin→`201`; `POST /order/checkout {}`→`201` + `reservedAmount` inc + cart empty; concurrent `Promise.all` single-winner 201 vs 409.
- Migration executed with `synchronize:false`.

## References

- `specs/007-order-integration/spec.md` §§2-9, clarifications Q1-Q9 Session 2026-09-21
- `specs/007-order-integration/plan.md` Phase 6, `research.md` D1-D9, `data-model.md` CheckoutTransaction
- `specs/007-order-integration/contracts/order-checkout.md`, `quickstart.md` §4.1-4.5
