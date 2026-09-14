# Contracts — Reservation Lifecycle (Phase 4)

**Branch**: `004-reservation-lifecycle` | **Date**: 2026-09-14 | **Spec**: [spec.md](../spec.md)

All routes below are already thin wrappers around `ReservationService` inside `dataSource.transaction(manager => service.*(manager,...))` (`src/modules/reservation/reservation.controller.ts:65,76,84`). Phase 4 makes the service transactional; the HTTP contract shape does not change except idempotent `200` on `COMPLETED→COMPLETED` (Q4). Base path `/reservations` via `ReservationController`; global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform) + `AllExceptionsFilter` (`{statusCode,message,timestamp}`) + `JwtGuard`/`RolesGuard` (`@Auth`, `@CurrentUser`) still apply.

---

## 1. PATCH /reservations/:id/complete

- **Auth**: `@Auth(User,Admin)` + ownership via `assertOwner` (owner `userId==reservation.userId` or `Admin`). Non-owner non-admin → `403`.

- **Request**:
  ```http
  PATCH /reservations/:id/complete
  Authorization: Bearer <JWT>
  Content-Type: application/json
  Body: { "orderId"?: "<uuid>" }  // UpdateReservationStatusDto; orderId optional
  ```

- **Success (RESERVED → COMPLETED)** — `200`:
  ```json
  { "id":"...","userId":"...","orderId":"...|null","status":"COMPLETED","expiresAt":"...","createdAt":"...","updatedAt":"...","items":[{ "reservationId":"...","inventoryId":"...","quantity":3 }]}
  ```
  **Inventory side-effect (inside same transaction, FR-002 + Q2/Q3):** for each item `A` `stock -= qty`, `reservedAmount -= qty` via `manager.getRepository(Inventory).save`; if `orderId` supplied, `Reservation.orderId` overwritten to that value (validated `Order` exists, else `404` rollback). `available` unchanged moment-of-transition (`stock - reserved` shifts equally).

- **Idempotent retry (Q4: B)** — `200`:
  If reservation already `COMPLETED` and caller again `PATCH /:id/complete` (same or different `orderId`? `orderId` still overwrites per Q3 if supplied, but no inventory re-mutation):
  ```json
  // 200, not 409; body same COMPLETED entity, Inventory.stock/reservedAmount unchanged since first completion
  ```

- **Errors**:
  - `401` — missing/invalid JWT
  - `403` — `You are not allowed to access this reservation` (ownership)
  - `404` — `Reservation <id> not found` / `Order <orderId> not found` / `Inventory <inventoryId> not found` (deleted between reserve and complete) → rollback, status unchanged
  - `409` — `Invalid reservation transition: <from> -> COMPLETED` for any `from != RESERVED` except idempotent `COMPLETED→COMPLETED`; or DB invariant violation surfacing as `409` per FR-007
  - `400` — DTO validation `orderId` not UUID, etc.

- **Transaction**: `BEGIN → lock Reservation FOR UPDATE → assertOwner → validateTransition (allow idempotent COMPLETED→COMPLETED) → verify orderId exists → lock sorted Inventories FOR UPDATE → mutate Inventories → save Reservation → COMMIT` else `ROLLBACK`.

---

## 2. PATCH /reservations/:id/cancel

- **Auth**: `@Auth(User,Admin)` + `assertOwner`; `403` if non-owner non-admin.

- **Request**:
  ```http
  PATCH /reservations/:id/cancel
  Authorization: Bearer <JWT>
  ```

- **Success (RESERVED → CANCELLED)** — `200`:
  ```json
  { "id":"...","status":"CANCELLED","items":[...]}
  ```
  **Inventory side-effect (FR-003):** per item `reservedAmount -= qty`, `stock` unchanged; lock sorted inventories. `available` increases by `qty`.

- **Errors**:
  - `409` — `Invalid reservation transition: CANCELLED -> CANCELLED` / `COMPLETED -> CANCELLED` / `EXPIRED -> CANCELLED` etc. (Q5: `CANCELLED→CANCELLED` remains `409`, not idempotent)
  - `403` / `404` as above; status/Inventory unchanged on any error.

---

## 3. PATCH /reservations/:id/expire

- **Auth**: `@Auth(Admin)` on controller (`src/modules/reservation/reservation.controller.ts:81-82`). Non-admin → `403`. In Phase 5 the background worker will call `reservationService.expire(manager,id)` directly (service-level, bypassing `Auth` guard) but still inside `dataSource.transaction`.

- **Request**:
  ```http
  PATCH /reservations/:id/expire
  Authorization: Bearer <admin JWT>
  ```

- **Success (RESERVED → EXPIRED)** — `200`:
  ```json
  { "id":"...","status":"EXPIRED" }
  ```
  **Inventory side-effect (FR-003 + Q1 A / D3):** per item `reservedAmount -= qty`, `stock` unchanged; **does not check `expiresAt <= NOW()`** — any `RESERVED` reservation may be expired immediately as admin override; Phase 5 worker is the time-gate (`WHERE status='RESERVED' AND expiresAt<=NOW()`).

- **Errors**:
  - `409` — `Invalid reservation transition: * -> EXPIRED` (`EXPIRED→EXPIRED` remains `409` per Q5 A; not idempotent) / `COMPLETED→EXPIRED`, `CANCELLED→EXPIRED`
  - `403` — non-admin
  - `404` — `Reservation <id> not found`

---

## 4. Unchanged read contracts (already in Phase 2/3, not re-described here)

- `POST /reservations` → `201 RESERVED` transactional creation (Phase 3 `FOR UPDATE` sorted Inventories, `available>=qty`, `reserved+=qty`) — not changed in Phase 4.
- `GET /reservations/:id` — owner-or-admin, relations `items`
- `GET /reservations?page=&limit=&userId=` — owner-scoped, admin can filter `userId`, paginated `{data, meta:{totalItems,itemCount,itemsPerPage,totalPages,currentPage}}`

## 5. Error serialization

All `HttpException` subclasses map via `AllExceptionsFilter`:

```json
// REST error
{ "statusCode": 409, "message": "Invalid reservation transition: COMPLETED -> CANCELLED", "timestamp": "2026-09-14T..." }

// inventory invariant mapped
{ "statusCode": 409, "message": "Inventory stock invariant violated" }
```

GraphQL not used for reservations (REST only).

## 6. Concurrency & Single-winner guarantee

For any two concurrent `PATCH /:id/complete|cancel|expire` on the same `RESERVED` reservation, the service locks `Reservation FOR UPDATE` so exactly one commits with `200` and inventory mutated once; the loser, after acquiring the lock, sees `status != RESERVED` and returns `409` — except `COMPLETED→COMPLETED` second `200` idempotent which returns `200` without re-mutating (FR-008, Q4). Verified by integration test `spec.md` SC-005.

OpenAPI/Swagger (`/api`) reflects the same `bearer` auth + `UpdateReservationStatusDto` (`orderId?: uuid`) for `complete`; `cancel`/`expire` have empty bodies per controller.

