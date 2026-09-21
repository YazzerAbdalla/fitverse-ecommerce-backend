# Data Model — Order Integration — Checkout-Only Reservation Refactor (Phase 6)

**Branch**: `007-order-integration` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Phase 6 adds `Order`/`OrderItem` correctness (migration) and **refactors Reservation to be checkout-only** (no schema change). Model reuses Phase 1-5 entities; only `Order`/`OrderItem` DDL changes. No new queues; Redis/RabbitMQ not touched by checkout.

---

## 1. Entities

### Order — **FIX** (`src/modules/order/entities/order.entity.ts`) — was `ManyToMany` + `@JoinTable` (incorrect)

```text
Order {
  id: uuid PK
  userId: uuid FK User.id ON DELETE CASCADE, INDEX(userId), INDEX(status) composite not needed but status index added
  status: enum PENDING|COMPLETED|CANCELLED|FAILED default PENDING, INDEX(status), CHECK status IN (...)
  total: int default 0, CHECK total>=0  // Σ quantity*unit_price, cents, server-calculated
  createdAt: timestamptz, updatedAt: timestamptz
  orderItems: OrderItem[] OneToMany cascade (was ManyToMany — drop join table order_order_items_order_item)
  user: User ManyToOne, JoinColumn(userId)
}
```

- Migration `17xxxxx-OrderIntegrationCheckoutOnly`: drop join table if exists, add column `userId` FK, add `status` enum corrected, add `total` CHECK, add indexes `userId`/`status`. `synchronize:false`.

### OrderItem — **FIX** (`src/modules/order/entities/order-items.entity.ts`)

```text
OrderItem {
  id: uuid PK
  orderId: uuid FK Order.id ON DELETE CASCADE, INDEX(orderId), UNIQUE(orderId,productId)
  productId: uuid FK Product.id ON DELETE RESTRICT, INDEX(productId)  // Q3 Option A: productId only, no inventoryId
  quantity: int, CHECK quantity>0
  unit_price: int, CHECK unit_price>=0  // snapshot of Product.price at checkout, cents
  productNameSnapshot: varchar nullable optional
  subtotal: int GENERATED STORED as quantity*unit_price OR computed in service (not client-supplied)
  order: Order ManyToOne, JoinColumn(orderId)
  product: Product ManyToOne, JoinColumn(productId)
}
```

- Was `product_id` as `ManyToOne Product` with `@JoinColumn` but `order_id` was `ManyToOne Order order_id: Order` (naming confused) and no `Unique`. Migration adds `orderId` FK with CASCADE, `productId` FK RESTRICT, CHECKs, indexes.

### OrderStatus enum — **FIX** (`src/modules/order/order-status.enum.ts`)

```text
enum OrderStatus {
  PENDING = 'PENDING',        // initial after checkout, reserved
  COMPLETED = 'COMPLETED',    // Phase 7 (stock-=qty)
  CANCELLED = 'CANCELLED',    // Phase 8
  FAILED = 'FAILED',
}
```

- Renames PG enum values `SUCCESS→COMPLETED`, `FAILD→FAILED`; adds `CANCELLED`/`FAILED`. Migration uses `ALTER TYPE ... RENAME VALUE` or `CREATE TYPE ...` + column alter.

### Reservation — **UNCHANGED schema**, controller/service refactor (`src/modules/reservation/entities/reservation.entity.ts`)

```text
Reservation {
  id: uuid PK
  userId: uuid FK User.id ON DELETE CASCADE, INDEX
  orderId: uuid nullable FK Order.id ON DELETE SET NULL, INDEX nullable  // checkout always sets orderId, but nullable kept for existing data + expiration worker tolerance
  status: enum RESERVED|COMPLETED|EXPIRED|CANCELLED default RESERVED, INDEX + composite INDEX(status,expiresAt)
  expiresAt: timestamptz, INDEX + composite
  createdAt: timestamptz, updatedAt: timestamptz
  items: ReservationItem[] OneToMany cascade
}
```

- **Refactor**: `POST /` controller method removed for User (returns `403` or `404`). Service `create(manager,userId,dto)` becomes **`createForCheckout(manager,userId,items,orderId)`** internal — same validation (future expiresAt, quantity>0, duplicate inventoryId) but assumes caller holds `FOR UPDATE` on inventories. Manual creation for User no longer exists; Admin may keep internal path for testing but not User.

### ReservationItem — **UNCHANGED** (`src/modules/reservation/entities/reservation-item.entity.ts`)

```text
ReservationItem {
  id: uuid PK
  reservationId: uuid FK Reservation.id ON DELETE CASCADE, INDEX
  inventoryId: uuid FK Inventory.id, INDEX
  quantity: int, CHECK quantity>0, UNIQUE(reservationId,inventoryId)
}
```

- `quantity` source for `reservedAmount` delta; checkout reads via `manager` relations, not client payload.

### Inventory — **UNCHANGED** (`src/modules/inventory/entities/inventory.entity.ts`)

```text
Inventory {
  id: uuid PK
  productId: uuid FK Product.id ON DELETE CASCADE, UNIQUE, INDEX
  stock: int CHECK stock>=0
  reservedAmount: int CHECK reservedAmount>=0, CHECK reservedAmount<=stock
  available = stock - reservedAmount (derived)
}
```

- Only mutated via checkout `reservedAmount+=qty` ( Phase 6) and later worker `reservedAmount-=qty` / complete `stock-=qty reserved-=qty`. No new column.

### Cart / CartItem — **UNCHANGED** (`src/modules/cart/entities/cart.entity.ts` / `cart-items.entity.ts`)

```text
Cart { id: uuid PK, userId FK User.id UNIQUE, cartItems: CartItem[] OneToMany }
CartItem { id: uuid PK, cart ManyToOne, product ManyToOne eager, quantity int CHECK>0 }
```

- Checkout clears via `CartService.clearCartForCheckout(manager,userId)` using `EntityManager` (DELETE via `manager`, not fire-and-forget `deleteCartItemsInBackground`).

### Product — **UNCHANGED** (`src/modules/products/entities/product.entity.ts`)

```text
Product { id: uuid PK, name UNIQUE INDEX(name), slug, description, price int CHECK>=0, inventory 1-1 }
```

- Price snapshot source; no lock needed.

---

## 2. Non-PG State

None new. BullMQ `reservation-expiration` queue (Redis) remains Phase 5, unchanged. Checkout performs **no** Redis/RMQ I/O (Q5 Option B deferred to Phase 11).

---

## 3. Transaction Models

### Checkout — single `DataSource.transaction` (refactored to be sole `reservedAmount` producer)

```
BEGIN // dataSource.transaction(async manager => orderCheckoutService.checkout(manager, userId))
  // 1. Load cart (via manager, not repository)
  cart = SELECT cart WHERE userId=:userId WITH cartItems+product  // manager.findOne(Cart, {where:{user:{id:userId}}, relations:{cartItems:{product:true}}})
  if !cart or cartItems.length==0 → 400 "Cart is empty" → ROLLBACK

  // 2. Collect productIds → inventoryIds via product.inventory? Actually inventoryId via Product→Inventory lookup
  //    For each cartItem: product = cartItem.product; inventory = SELECT inventory WHERE productId=:product.id (via manager, not locked yet)
  //    Collect price snapshot: unit_price = product.price (validate >=0)

  // 3. Deterministic ordering
  sortedIds = [...new Set(inventoryIds)].sort()

  // 4. Lock inventories
  SELECT inventory WHERE id IN(:sortedIds) FOR UPDATE // pessimistic_write via manager.find
  if count != sortedIds.length → 404 Inventory not found → ROLLBACK
  // verify available
  for each item: if (stock - reservedAmount) < requestedQty → 409 Conflict → ROLLBACK

  // 5. Increment reservedAmount (sole producer after refactor)
  for each item: inv.reservedAmount += qty; manager.save(inv) // CHECK backstop 23514 → 409

  // 6. Create Order
  order = manager.create(Order, {userId, status:PENDING, total: Σ qty*unit_price})
  order = manager.save(order)

  // 7. Create OrderItems (historical)
  orderItems = items.map(i => manager.create(OrderItem, {orderId:order.id, productId:i.productId, quantity:i.qty, unit_price:i.price}))
  manager.save(orderItems)

  // 8. Create Reservation (internal, no re-lock)
  reservation = reservationService.createForCheckout(manager, userId, itemsWithInventoryId, order.id)
  //   → validates items, creates Reservation {userId, orderId, status:RESERVED, expiresAt: now+15m} + ReservationItems via manager

  // 9. Clear cart (via manager)
  DELETE CartItem WHERE cartId=:cart.id via manager.delete(CartItem, {cart:{id:cart.id}})

COMMIT // or ROLLBACK on any throw
// no publish after commit in Phase 6 (deferred)
```

- Manual `POST /reservations` for User no longer exists, so this is the **only** path that increments `reservedAmount` in Phase 6.

### Reservation expiration — extended Phase 6 (Q8 B) — auto-cancel Order

```
SELECT id FROM reservation WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt, id LIMIT batchSize
for each id: transaction(expireOne) // FOR UPDATE Reservation WHERE id=:id, check status==RESERVED else skip,
 // FOR UPDATE sorted Inventories WHERE id IN(:sorted) (deterministic),
 // reservedAmount -= qty (stock unchanged), Reservation status=EXPIRED,
 // Order WHERE id=reservation.orderId FOR UPDATE → status PENDING→CANCELLED (same manager commit)
 // publish reservation.expired after commit (existing); Order CANCELLED is observable via GET /order/:id
```

---

## 4. Validation & Error Table (checkout path + refactored reservation)

| Condition | Check Location | Error / Handling | Inventory Effect | Status Effect |
|-----------|---------------|------------------|------------------|---------------|
| Empty cart | before lock, via manager | `400 Cart is empty` → rollback | none | none |
| Cart product missing Inventory row | after lock, `length != sortedIds.length` | `404 Inventory <id> not found` → rollback | none | none |
| `available < qty` | after `FOR UPDATE` inventory | `409 Conflict Insufficient available` → rollback, no partial | none | none |
| `quantity <=0` or duplicate product in cart | before lock, DTO + service | `400` → rollback (never reaches tx inventory lock) | none | none |
| Checkout body contains `items[]`/`orderId`/`reservationId` | `CheckoutDto` empty + `forbidNonWhitelisted` | `400` validation → never enters tx | none | none |
| `POST /reservations` as User (after refactor) | `@Auth(Admin)` guard or deleted route | `403 Forbidden Use POST /order/checkout` (or `404`) | none | none |
| `CHECK` violation (`reservedAmount>stock` etc.) | `manager.save` | caught `23514` → `409` → rollback | rollback | none |
| `GET /order/:id` non-owner non-admin | `assertOwner` | `403 Forbidden` | none | none |

## 5. Indexes / Constraints (existing + migration)

- `Reservation`: `@Index(userId)`, `@Index(status)`, `@Index(expiresAt)`, `@Index(status,expiresAt)` composite — scan unchanged.
- `ReservationItem`: `@Index(reservationId)`, `@Index(inventoryId)`, `@Unique(reservationId,inventoryId)`, `@Check quantity>0`.
- `Inventory`: `@Index(productId)`, `@Unique(productId)`, `@Check stock>=0`, `@Check reservedAmount>=0`, `@Check reservedAmount<=stock`.
- `Order` (NEW via migration): `@Index(userId)`, `@Index(status)`, `@Check total>=0`.
- `OrderItem` (NEW): `@Index(orderId)`, `@Index(productId)`, `@Unique(orderId,productId)`, `@Check quantity>0`, `@Check unit_price>=0`.

## 6. Clarification Integration Points (Q1-Q9 + directives)

| Q | Spec Clarification / Directive | Data-Model Impact |
|---|-------------------------------|-------------------|
| Q1 | Cart-only checkout (empty DTO) | `CheckoutDto` empty; no `items[]` column |
| Q2 | Reservation atomic via `createForCheckout` | Service method signature change, no controller POST for User |
| Directive | Checkout-only reservation (remove manual POST for User) | Controller `POST /` → `403` for User (`POST` keep for Admin), service internalization; no PG column added but reservation producer reduced to one |
| Q3 | productId FK only | `OrderItem.productId` FK RESTRICT, no `inventoryId` |
| Q4 | Enum migration now | Migration renames `SUCCESS/FAILD` → `PENDING|COMPLETED|CANCELLED|FAILED` |
| Q5 | Defer event | No outbox/RMQ column in Phase 6 |
| Q6 | POST block User / keep Admin (A) | Controller `@Auth(Admin)` on `POST /reservations`; User → `403` |
| Q7 | PATCH complete/cancel restrict for User (B) | `PATCH /:id/complete|cancel` → `403` for User on checkout reservations; only Admin/worker/internal Order service |
| Q8 | Order auto-CANCELLED on Reservation expiry (B) | Worker transaction also `FOR UPDATE Order` → `PENDING→CANCELLED` same commit as `RESERVED→EXPIRED` |
| Q9 | GET reservationId-only (A) | `GET /order/:id` returns `reservationId` string, not embedded object; no JOIN to ReservationItem in Order query |
