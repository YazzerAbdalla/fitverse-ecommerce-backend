# ADR 0007 — Inventory / Reservation Intended Model

- **Status:** Intended (designed in `docs/plan.md`, **not yet implemented**)
- **Context:** The store must sell limited stock without overselling, support
  temporary holds (reservations), and recover from expired holds — while keeping
  PostgreSQL authoritative.
- **Decision (target design):** Separate **Inventory** (`stock`,
  `reserved_amount`, `available = stock - reserved_amount`) from **Product**;
  add **Reservation** (+ optional **ReservationItem**) with explicit `expires_at`
  and states `RESERVED → COMPLETED | EXPIRED | CANCELLED`. All reservation +
  inventory writes are **transactional with pessimistic row locking**. A background
  job expires reservations and releases `reserved_amount`. RabbitMQ events publish
  only after the DB commit.
- **Consequences:** Today only `InventoryService.decrease/restoreStockForOrderMany`
  exist (mutating `Product.stock` directly, no entity). Implementing this ADR
  requires new entities, a real reservation lifecycle, and a cleanup worker — to be
  driven by a Spec Kit specification, not by guessing business rules.
- **Source:** `docs/plan.md` §5–§35,
  `docs/architecture/inventory-reservation.md`.
- **Open questions:** reservation TTL, reserve-at-cart vs reserve-at-checkout,
  need for `ReservationItem` now, order state machine.
