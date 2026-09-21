# Contract — Order Checkout (Phase 6) + Reservation Refactor

**Branch**: `007-order-integration` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

## 1. `POST /order/checkout` — cart-only (NEW, checkout-only reservation)

- **Auth**: `JwtGuard` via `@Auth()` — `UnauthorizedException 401` if missing/invalid JWT
- **Request**: `POST /order/checkout` (alias `POST /order` deprecated but redirects to same handler)
  ```http
  POST /order/checkout HTTP/1.1
  Authorization: Bearer <JWT>
  Content-Type: application/json

  {} // empty body; any field → 400
  ```
  - DTO: `class CheckoutDto {}` — no fields. Global `ValidationPipe` (`whitelist:true, forbidNonWhitelisted:true, transform:true`) rejects any `items`, `reservationId`, `orderId`, etc. with `400 {statusCode:400, message:["property items should not exist"], ...}`.
  - Cart implied: server loads `Cart` + `CartItem[]` + `Product` for `requestingUserId = payload.sub` via `EntityManager` inside transaction.

- **Success**: `201 Created`
  ```json
  {
    "id": "order-uuid",
    "userId": "user-uuid",
    "status": "PENDING",
    "total": 250,
    "createdAt": "2026-09-21T00:00:00.000Z",
    "expiresAt": "2026-09-21T00:15:00.000Z",
    "reservationId": "reservation-uuid",
    "items": [
      { "id": "oi-uuid-1", "productId": "prod-a-uuid", "quantity": 2, "unitPrice": 100, "subtotal": 200, "productName": "A" },
      { "id": "oi-uuid-2", "productId": "prod-b-uuid", "quantity": 1, "unitPrice": 50, "subtotal": 50 }
    ]
  }
  ```
  - `total = Σ quantity*unitPrice` server-calculated, cents int. `reservationId` is the `Reservation.id` created atomically with `orderId=Order.id`, `status=RESERVED`, `expiresAt=now+15m`. `Cart` is empty after commit.

- **Errors**:
  | Code | Condition | Body |
  |------|-----------|------|
  | 400 | Cart empty | `{statusCode:400, message:"Cart is empty"}` |
  | 400 | Validation (any field in body, quantity ≤0, duplicate product) | `{statusCode:400, message:[...], timestamp}` |
  | 401 | Missing/invalid JWT | `{statusCode:401, ...}` |
  | 404 | Product or Inventory row missing (deleted between add-to-cart and checkout) | `{statusCode:404, message:"Inventory <id> not found"}` or `"Product not found"` |
  | 409 | Insufficient available (`available = stock - reservedAmount < qty`) or DB CHECK `23514` | `{statusCode:409, message:"Insufficient available inventory for <inventoryId>..."}` |
  | 500 | Unexpected | `{statusCode:500,...}` |

- **Invariants**: All writes in one `DataSource.transaction`; no partial `Order`/`Reservation`/`Inventory`; no Redis/RMQ inside tx; historical `unitPrice` frozen (price mutated after commit does not affect row).

- **Swagger**: `@ApiOperation({summary:"Checkout cart → Order + Reservation"})`, `@ApiResponse({status:201, type: CheckoutResponseDto})`, `@ApiBearerAuth('JWT-auth')`.

## 2. `GET /order` — list own orders (NEW)

- **Auth**: `JwtGuard`
- **Request**: `GET /order?page=1&limit=20&status=PENDING` (status optional, validated `IsEnum(OrderStatus)`)
- **Success**: `200`
  ```json
  {
    "data": [ { "id": "order-uuid", "status":"PENDING", "total":250, "createdAt":"...", "items": [ ... ] } ],
    "meta": { "totalItems": 3, "itemCount": 1, "itemsPerPage": 20, "totalPages": 1, "currentPage": 1 }
  }
  ```
  - Pagination shape `skip=(page-1)*limit`, reused from `products.service.ts:findAll`. Owner-scoped: `where: {userId: requestingUserId}` unless `role=ADMIN` and `?userId=` filter supplied.
  - `items` included via `relations:{orderItems:{product:true}}` or `leftJoinAndSelect`.

- **Errors**: `401`, `400` invalid pagination/status.

## 3. `GET /order/:id` — fetch one order (NEW)

- **Auth**: `JwtGuard` + `assertOwner`
- **Request**: `GET /order/:id`
- **Success**: `200` same shape as single order with `reservationId` (via `Reservation` join on `orderId`).
- **Errors**: `401`, `403` if `order.userId !== requestingUserId && role !== Admin`, `404` if not found.

## 4. `POST /reservations` — **REFACTORED to checkout-only (breaking change)**

- **Before** (Phases 2-5): `POST /reservations @Auth(User,Admin)` created reservation for any `inventoryId`s.
- **After** (Phase 6): **User role blocked**. Options (plan chooses one, both satisfy spec — document chosen):
  - **(A) Deleted**: route removed → `404 Not Found` for all callers.
  - **(B) Guarded**: `@Auth(Admin)` only → `POST /reservations` returns `403 Forbidden {message:"Reservation can only be created via POST /order/checkout"}` for `User`.

- **Spec impact**: `CreateReservationDto` no longer exposed to User; internal type `CreateForCheckout {inventoryId, quantity}[]` remains for service. `GET /reservations/:id`, `GET /reservations`, `PATCH /:id/complete|cancel|expire` remain unchanged for read/lifecycle and expiration worker. `complete`/`cancel` for checkout-created reservations will eventually be driven by `Order` lifecycle (Phases 7-8), but remain for manual admin/testing.

- **Tests**: Integration test `POST /reservations` as User → expect `403` (or `404` if deleted). Admin `POST` may still `201` for testing but is not the user path.

## 5. No new events in Phase 6

- `reservation.expired` (RabbitMQ) remains Phase 5 worker post-commit. `order.created` is **deferred to Phase 11** per spec Q5 Option B — no `ClientProxy` emit from checkout in Phase 6, so contract has no event payload to document.
