# Contract: Reservation API — Transaction-Safe Creation (Phase 3)

**Feature**: `003-transaction-safe-reservation` | **Date**: 2026-08-30 | **Spec**: [spec.md](../spec.md)

No new endpoints in Phase 3. This contract clarifies the **behavioral** (transactional) contract of the existing `POST /reservations` route under Phase 2, as augmented by Phase 3 locking/availability logic. All other routes (`GET /:id`, `GET /`, `PATCH /:id/complete|cancel|expire`) retain Phase 2 status-only behavior (no inventory mutation) per `spec.md` FR-009.

---

## `POST /reservations` — Create reservation (now transaction-safe)

- **Auth**: `@Auth(UserRoles.User, UserRoles.Admin)` + `JwtGuard` + `RolesGuard`. `@CurrentUser('sub')` supplies `requestingUserId`. Unauthenticated → `401`; non-owner never relevant on create (always self).
- **Request body**: `CreateReservationDto`

```json
{
  "expiresAt": "2026-08-30T12:15:00.000Z",   // optional ISO 8601 date-string; if omitted → server defaults to now+15m; if supplied must be future
  "orderId": "uuid-or-null",                // optional UUID; must reference existing Order if supplied, else 404
  "items": [
    { "inventoryId": "uuid", "quantity": 2 },
    { "inventoryId": "uuid", "quantity": 1 }
  ]
}
```

- **Validation (global ValidationPipe: whitelist + forbidNonWhitelisted + transform)**:
  - `items` required, `@ArrayMinSize(1)`, each `inventoryId` `@IsUUID`, `quantity` `@IsInt @Min(1)`.
  - `expiresAt` `@IsDateString` if present (future check in service).
  - `orderId` `@IsUUID` if present.
  - Unknown fields → `400`; empty `items` → `400`; `quantity` 0/negative/non-int → `400`.
  - Duplicate `inventoryId` within `items` → `400 BadRequestException("Duplicate inventoryId in request: ...")` (DB unique as safety net → `409` on race).

- **Success (within `available`)**:
  - **Code**: `201 Created`
  - **Body** (reservation with items, `status=RESERVED`):
```json
{
  "id": "uuid",
  "userId": "uuid",
  "orderId": null,
  "status": "RESERVED",
  "expiresAt": "2026-08-30T12:15:00.000Z",
  "createdAt": "2026-08-30T12:00:00.000Z",
  "updatedAt": "2026-08-30T12:00:00.000Z",
  "items": [
    { "id": "uuid", "reservationId": "uuid", "inventoryId": "uuid", "quantity": 2, "createdAt": "...", "updatedAt": "..." }
  ]
}
```
  - **Side effect**: Inside a single `dataSource.transaction`, each referenced `Inventory` row is locked `FOR UPDATE` in deterministic `inventoryId`-sorted order, `available = stock - reservedAmount` is checked against `quantity` for every item, and `Inventory.reservedAmount` is incremented by `quantity`. Then `Reservation` + `ReservationItem`s are inserted atomically. Measurable: `GET /inventory/:productId` after shows `reservedAmount` increased by requested amount.

- **Failure — insufficient `available`**:
  - **Code**: `409 Conflict`
  - **Body**: `{ "statusCode": 409, "message": "Insufficient available inventory for <inventoryId>. Available: 2, requested: 3", "timestamp": "..." }`
  - **Side effect**: Transaction rolls back; no `Reservation` row, no `reservedAmount` change, no partial items.

- **Failure — unknown `inventoryId`**:
  - **Code**: `404 Not Found` — `Inventory <id> not found` — rolled back, no side effect.

- **Failure — unknown `orderId`**:
  - **Code**: `404 Not Found` — `Order <id> not found` — rolled back.

- **Failure — `expiresAt` in past / invalid**:
  - **Code**: `400 Bad Request` — `expiresAt must be a future timestamp` — rolled back (or rejected before tx).

- **Failure — `available` DB CHECK violation** (should not happen if pre-check correct; safety net):
  - **Code**: `409 Conflict` (mapped from `QueryFailedError` if surfaced) — rolled back.

- **Concurrency contract** (normative for this phase):
  - Two concurrent `POST /reservations` that together would exceed `available` if both committed MUST result in exactly one `201` and one `409`. Final `reservedAmount` equals initial + one request's quantity, never initial + both (no overselling).
  - Two concurrent requests whose payloads list the same inventories in opposite order MUST NOT deadlock — deterministic `inventoryId` sorting guarantees lock acquisition order. Both transactions complete (success per availability or `409`).
  - Parallel requests for disjoint inventories both succeed (row-level, not table-level, locking).
  - Transaction contains only lock→check→increment→insert; no Redis/RabbitMQ/BullMQ/email I/O inside.

- **Idempotency**: No `Idempotency-Key` in Phase 3; retry after `409` is safe (transaction already rolled back). Duplicate submission with same client intent after a `201` creates a second reservation (idempotency deferred to Phase 12).

---

## Unchanged routes (status-only, Phase 2)

| Method | Path | Behavior in Phase 3 |
|--------|------|---------------------|
| `GET /reservations/:id` | owner-or-admin `findById` | reads reservation+items; no locking; `404`/`403`/`401` unchanged |
| `GET /reservations?page=&limit=&userId=` | owner-scoped paginated `listByUser` | no inventory mutation |
| `PATCH /reservations/:id/complete` | `RESERVED→COMPLETED` status-only | **no** `stock`/`reservedAmount` decrement in this phase (deferred to Phase 4) |
| `PATCH /reservations/:id/cancel` | `RESERVED→CANCELLED` status-only | **no** `reservedAmount` release in this phase (Phase 4) |
| `PATCH /reservations/:id/expire` | `@Auth(ADMIN)` `RESERVED→EXPIRED` status-only | **no** `reservedAmount` release in this phase (Phase 4); Phase 5 worker not in scope |

---

## Error serialization

All throw Nest exceptions (`BadRequestException`, `NotFoundException`, `ConflictException`, `ForbiddenException`, `UnauthorizedException`) and are serialized by `AllExceptionsFilter` as `{ statusCode, message, timestamp }` (REST) — consistent with `docs/api/conventions.md`.

## DTO reference

`src/modules/reservation/dto/create-reservation.dto.ts` — `CreateReservationDto` / `ReservationItemDto` (see [data-model.md](../data-model.md) §3).
