# Contract — Reservation Refactor Detail (Checkout-Only)

**Branch**: `007-order-integration` | **Spec**: [spec.md](../spec.md) | **Data Model**: [data-model.md](../data-model.md)

## Internal `ReservationService.createForCheckout` (not HTTP)

```ts
/**
 * Creates a Reservation atomically inside the caller's checkout transaction.
 * Caller must already hold FOR UPDATE on all inventoryIds in sorted order.
 * @param manager - EntityManager of the enclosing DataSource.transaction
 * @param userId - owner
 * @param items - {inventoryId, quantity}[] validated (quantity>0, no duplicate inventoryId)
 * @param orderId - Order.id to link (server-generated, not client-supplied)
 * @returns Reservation with items
 * @throws BadRequestException duplicate/quantity, NotFoundException Inventory missing, ConflictException CHECK
 */
async createForCheckout(
  manager: EntityManager,
  userId: string,
  items: Array<{ inventoryId: string; quantity: number }>,
  orderId: string,
): Promise<Reservation>
```

- Validation mirrors `ReservationService.create` but without `expiresAt` in DTO (always `now+15m` via `DEFAULT_TTL_MS`) and without `orderId` in DTO (explicit param).
- Called only by `OrderCheckoutService.checkout(manager, userId)` after inventories locked and `Order` created. No re-lock.

## Controller change

```diff
- @Post()
- @Auth(UserRoles.User, UserRoles.Admin)
- async create(@CurrentUser('sub') userId, @Body() dto: CreateReservationDto) { ... }
+ // REMOVED for User — reservation only via POST /order/checkout
+ // Option: keep for Admin only
+ @Post()
+ @Auth(UserRoles.Admin)
+ async create(@CurrentUser('sub') userId, @Body() dto: CreateReservationDto) {
+   // returns 403 for User with message "Use POST /order/checkout"
+ }
```

Swagger `@ApiExcludeEndpoint` or `@ApiResponse(403)` documenting the 403. Existing `GET` and `PATCH` routes unchanged.

## Migration of tests

| Old test (Phases 2-5) | New expectation (Phase 6) |
|------------------------|---------------------------|
| `POST /reservations` as User with `inventoryId` → `201` | `→ 403 Forbidden` (or `404` if deleted) |
| `POST /reservations` as Admin → `201` | remains `201` (if Admin kept) or use internal service directly |
| Checkout creates Order+Reservation atomically | `POST /order/checkout` → `201` with `reservationId` |
| Concurrent `POST /reservations` vs `POST /order/checkout` single-winner | Removed — only `POST /order/checkout` vs `POST /order/checkout` single-winner remains |
