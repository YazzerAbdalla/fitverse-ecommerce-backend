# Contract: Reservation API (Phase 2)

**Feature**: `002-reservation-domain` | **Date**: 2026-08-22
**Module**: `src/modules/reservation` | **Auth**: `JwtGuard` via `@Auth()`

> Phase 2 exposes a thin REST controller. Business logic lives in `ReservationService`.
> All bodies validated by global `ValidationPipe` (whitelist, forbidNonWhitelisted, transform).

---

## Base

- **Prefix**: `/reservations`
- **Auth**: `Authorization: Bearer <JWT>` required for all endpoints
- **Error format**: `{ statusCode, message, timestamp }` (from `AllExceptionsFilter`)
- **Owner scoping**: Mutations and reads check `reservation.userId === requestingUserId || requestingRole === ADMIN`

---

## 1. Create reservation

**POST /reservations**

- **Auth**: `true`
- **Body**: `CreateReservationDto`
```json
{
  "expiresAt": "2026-08-22T12:15:00.000Z", // optional, default now+15m, must be future
  "items": [
    { "inventoryId": "uuid", "quantity": 2 },
    { "inventoryId": "uuid", "quantity": 1 }
  ]
}
```
- **Validation**:
  - `items` min 1, each `inventoryId` uuid exists (else 404), `quantity` int >=1 (else 400), unique `inventoryId` within request (else 400/409)
  - `expiresAt` if supplied must be future (else 400)
- **Success**: `201 Created` with `ReservationResponse` (status `RESERVED`, items persisted)
- **Errors**: `400` validation, `401` unauthenticated, `404` inventory not found
- **Service**: `ReservationService.create(manager: EntityManager, requestingUserId, dto)` — manager supplied via `DataSource.transaction` (Phase 2 even before locking, per clarification)

---

## 2. Get reservation by id

**GET /reservations/:id**

- **Auth**: `true` (owner or admin)
- **Params**: `id` uuid
- **Success**: `200` with `ReservationResponse` including `items` (+ optional `inventory` relation)
- **Errors**: `401`, `403` (not owner), `404` unknown id

---

## 3. List own reservations (paginated)

**GET /reservations?page=1&limit=20**

- **Auth**: `true`
- **Query**: `PaginationDto` `{ page?: number, limit?: number }` (default page 1, limit 20, max 100)
- **Behavior**: Returns only reservations where `userId === requestingUserId` unless `requestingRole === ADMIN` and optional `?userId=uuid` filter supplied
- **Success**: `200` with `{ data: ReservationResponse[], meta: { totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` (existing pagination shape)
- **Errors**: `401`, `400` bad pagination, `403` non-admin attempting userId filter

---

## 4. Complete reservation

**PATCH /reservations/:id/complete**

- **Auth**: `true` (owner or admin)
- **Params**: `id` uuid
- **Body**: optional `{ orderId?: "uuid" }` — Phase 2 allows setting order link on complete
- **Transition**: `RESERVED → COMPLETED` only; otherwise `409 Conflict`
- **Success**: `200` with updated `ReservationResponse` (status `COMPLETED`)
- **Errors**: `401`, `403`, `404`, `409` invalid transition, `400` invalid orderId

> Phase 2: status-only update. Inventory `stock/reservedAmount` adjustment is Phase 4.

---

## 5. Cancel reservation

**PATCH /reservations/:id/cancel**

- **Auth**: `true` (owner or admin)
- **Params**: `id` uuid
- **Transition**: `RESERVED → CANCELLED` only; otherwise `409`
- **Success**: `200` with `COMPLETED`? actually `CANCELLED` status
- **Errors**: `401`, `403`, `404`, `409`

---

## 6. Expire reservation (internal)

**PATCH /reservations/:id/expire**

- **Auth**: `admin` or internal worker (no public use in Phase 2)
- **Params**: `id` uuid
- **Transition**: `RESERVED → EXPIRED` only; otherwise `409`
- **Success**: `200` with `EXPIRED`
- **Note**: Primary expiration is Phase 5 cleanup worker; this endpoint is for testing/admin and is not the source-of-truth expiration (DB `expiresAt <= NOW()` is, per constitution/plan §5.1).

---

## Service contract (for cross-module callers)

```ts
class ReservationService {
  create(manager: EntityManager, requestingUserId: string, dto: CreateReservationDto): Promise<Reservation>;
  findById(requestingUserId: string, id: string, role?: UserRoles): Promise<Reservation>; // read: no manager needed
  listByUser(requestingUserId: string, pagination: PaginationDto, filter?: { userId?: string }): Promise<Paginated<Reservation>>;
  complete(manager: EntityManager, requestingUserId: string, id: string, dto?: { orderId?: string }, role?: UserRoles): Promise<Reservation>;
  cancel(manager: EntityManager, requestingUserId: string, id: string, role?: UserRoles): Promise<Reservation>;
  expire(manager: EntityManager, id: string): Promise<Reservation>; // internal / worker
  validateTransition(from: ReservationStatus, to: ReservationStatus): boolean; // throws ConflictException if invalid
}
```

- All service methods throw Nest HTTP exceptions (`BadRequest`, `NotFound`, `Conflict`, `Forbidden`, `Unauthorized`) — no plain objects.
- Phase 2 writes accept `EntityManager` per clarification Option B; controller wraps via `dataSource.transaction(m => service.create(m, userId, dto))`; reads remain non-transactional. Phase 3 will add pessimistic locks inside the transaction.

---

## Validation notes

- `ReservationStatus` is a Postgres enum (`RESERVED`, `COMPLETED`, `EXPIRED`, `CANCELLED`) — no other values accepted.
- `ReservationItem.quantity` `CHECK > 0` + DTO `@Min(1)`.
- Unique `(reservationId, inventoryId)` — duplicate items in same reservation rejected.

---

## Out of scope

- Phase 3: `available >= quantity` check with `FOR UPDATE` lock + `reservedAmount` mutation
- Phase 5: `BullMQ`/`@Cron` expiration worker querying `WHERE status='RESERVED' AND expiresAt <= NOW()`
- Phase 6: Checkout transaction atomically creating reservation + order
