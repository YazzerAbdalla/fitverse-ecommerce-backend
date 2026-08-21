# Database — Relationships

Textual ER diagram of the **current** entities (intended inventory/reservation
relations are in
[`../architecture/inventory-reservation.md`](../architecture/inventory-reservation.md)).

```text
User
 ├─ 1:1 ─ Cart
 │          └─ 1:N ─ CartItem
 │                        └─ N:1 ─ Product
 │
 ├─ 1:N ─ Order
 │          └─ M:N ─ OrderItem  (join table via @JoinTable)
 │                        └─ N:1 ─ Product
 │
 └─ (future) 1:N ─ Reservation ── (future) 1:N ─ ReservationItem ── Inventory ── Product

Product
 ├─ 1:N ─ CartItem
 └─ 1:N ─ OrderItem
```

## Cardinalities

- **User ↔ Cart** — `@OneToOne` (owning side `Cart` has `@JoinColumn`). One cart
  per user.
- **Cart ↔ CartItem** — `@OneToOne`? No: `Cart` `@OneToMany` CartItem;
  `CartItem` `@ManyToOne` Cart. `CartItem.product` is `@ManyToOne` Product with
  `eager: true`.
- **User ↔ Order** — `User` `@OneToMany` Order; `Order` `@ManyToOne` User.
- **Order ↔ OrderItem** — `Order` `@ManyToMany` OrderItem with `@JoinTable` on the
  `Order` side (OrderItem has no back-reference to Order). `OrderItem` also has
  `@ManyToOne` Product (`product_id`).
- **Product** is referenced by `CartItem` and `OrderItem` (no back-relations
  needed for navigation today, but `Product` declares `@OneToMany` to both for
  convenience).

## Notes

- `OrderItem.subtotal` is a **generated stored column** (`quantity * unit_price`) —
  DB-computed, not app-written.
- `CartItem` eager-loads its `Product`; other relations are lazy (use `relations`
  in `find*` or `leftJoinAndSelect` to avoid N+1).
- No soft-delete anywhere; deletions are hard deletes.
