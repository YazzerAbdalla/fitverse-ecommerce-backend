# Inventory & Reservation — Intended Design (not yet implemented)

This describes the **target** model per [`docs/plan.md`](../plan.md) §5–§35. It is
the intended architecture, **not** the current code (today `InventoryService`
mutates `Product.stock` directly and there is no `Reservation` entity). Treat this
as the design to implement when the inventory/reservation feature is specified.

## Conceptual separation

```text
Product
   │
   ▼
Inventory
   ├── stock            (owned units)
   ├── reserved_amount  (temporarily claimed)
   └── available = stock - reserved_amount
          │
          ▼
Reservation
   ├── quantity
   ├── status
   ├── expires_at        (source of truth for expiration)
   └── order_id (nullable)
          │
          ▼
ReservationItem   (when one reservation spans multiple products)
   ├── inventory_id
   └── quantity
```

## Invariants

- `available = stock - reserved_amount` (derive `available`; do **not** store it as
  a third independently-mutable value).
- `0 <= reserved_amount <= stock`.
- PostgreSQL is authoritative; Redis is **not** a source of inventory truth.

## Reservation states

```text
RESERVED → COMPLETED | EXPIRED | CANCELLED
```
Only these four; do not add `waiting`/`pending`/`active` without a requirement.

## Rules

- **Creation is transactional** with inventory lock
  (`pessimistic_write` / `SELECT … FOR UPDATE`): lock row → compute available →
  reject if insufficient → increment `reserved_amount` → create Reservation +
  ReservationItems → commit.
- **Expiration** is defined by `expires_at <= now()`; a background/cron job finds
  `status = RESERVED AND expires_at <= NOW()`, locks inventory, decrements
  `reserved_amount`, marks `EXPIRED`, commits.
- **Completion (sale):** `stock -= qty; reserved_amount -= qty`.
- **Cancellation:** if already sold → `stock += qty`; if still reserved →
  `reserved_amount -= qty`. Behavior depends on order state (define in spec).
- **Concurrency:** never compute availability by loading every reservation into
  app memory; rely on `reserved_amount` as the aggregate and row locks to prevent
  overselling. Two users racing for the last unit → only one succeeds.
- **Queue outside transaction:** publish RabbitMQ events *after* the DB commit.

## Where to implement

- `InventoryService` should become the only writer of `stock`/`reserved_amount`
  (it already is for `stock`); add `reserve()`, `releaseReservation()`,
  `completeSale()`, `increaseStock()`, `decreaseStock()`.
- Add `Inventory`, `Reservation`, `ReservationItem` entities under
  `src/modules/inventory/` (or a dedicated `reservations` module per `plan.md` §4).
- Index candidates: `inventory.product_id`, `reservation.status`,
  `reservation.expires_at`, `reservation.user_id`, `reservation.order_id`,
  `reservation_item.reservation_id`.

## Open questions (decide in the spec, not in code)

- Reservation duration (TTL).
- Reserve at cart-add vs only at checkout.
- Whether `ReservationItem` is needed now or later.
- Exact order status state machine (current `OrderStatus` enum is a stub).
- Cron vs queue worker for expiration cleanup.
