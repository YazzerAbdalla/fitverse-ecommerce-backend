# Contracts: Reliability / Idempotency — Phase 12

**Feature**: `012-reliability-idempotency` | **Date**: 2026-09-23 | **Spec**: [spec.md](../spec.md)

## 1. Admin Outbox Requeue (new) — Q1 B

### `PATCH /admin/outbox/:id/requeue`

**Auth**: `JwtGuard @Auth(Admin)` (`Bearer` `role==Admin` else `403`). `RateLimitGuard` inherits global `rl:*` (not Strictly throttled for admin, but `60/h` per admin via `products:mutation` bucket reuse is acceptable).

**Path Params**: `id: uuid` — `OutboxEvent.id`.

**Request Body**: `{}` (empty, `forbidNonWhitelisted`).

**Responses**:
- `200 OK`:
  ```json
  { "id": "uuid", "status": "PENDING", "attempts": 0, "nextRetryAt": "ISO", "eventType": "order.created" }
  ```
  Log `Logger.log outbox requeue id=:id eventType=:t by adminId=:adminId`
  `INCR idempotency:requeue:count` optional metric.
- `404 Not Found`: `{statusCode:404, message:"OutboxEvent not found", timestamp}` — if `id` not in `outbox_event`.
- `409 Conflict`: `{statusCode:409, message:"OutboxEvent not in FAILED status (status=PENDING|PROCESSING|SENT)"}` — only `FAILED` requeueable; `PENDING/PROCESSING/SENT` returns `409` (or `200` idempotent if already `PENDING`? V1 chooses `409` to avoid hiding).
- `403 Forbidden`: `{statusCode:403, message:"Forbidden"}` — `Customer|ContentManager|FulfillmentStaff|CoAdmin` cannot requeue (only `Admin` per RBAC matrix Phase 20).
- `400 Bad Request`: `{statusCode:400, message:"Validation failed"}` — `id` not `uuid`.
- `429 Too Many Requests`: headers `Retry-After`, `X-RateLimit-*`.

**Swagger**: `@ApiOperation({summary: 'Requeue FAILED outbox event (Admin only)'})` `@ApiParam({name:'id', type:'string', format:'uuid'})` `@ApiResponse({status:200, description:'PENDING'})` `@ApiResponse({status:404})` `@ApiResponse({status:409})` `@ApiResponse({status:403})` `@ApiBearerAuth()`.

**DB**: `SELECT OutboxEvent WHERE id=:id FOR UPDATE` inside `dataSource.transaction` → check `status==FAILED` → `UPDATE status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL processingStartedAt=NULL` → `COMMIT`. Publisher `FOR UPDATE SKIP LOCKED` will reclaim next poll `1s`.

**Idempotency**: Second `PATCH` on same `id` already `PENDING` after first requeue → `409` (not re-queued again) — caller must not double-requeue.

**Optional List** (already in Phase 11 plan, now required for ops): `GET /admin/outbox?status=FAILED&page=&limit=&eventType=&aggregateId=` `200 {data:OutboxEvent[], meta}` paginated `createdAt DESC` owner `Admin` only. Not new for Phase 12 but mentioned for `quickstart` verify.

---

## 2. Existing Business Endpoints — Idempotency Standardized (Q2 A)

### `PATCH /reservations/:id/expire` + `PATCH /reservations/:id/cancel` (Reservation)

Already `@Auth` owner-or-Admin, thin controller. Phase 12 hardens response contract:

- `200 OK` idempotent same-transition: `RESERVED→EXPIRED` first time `200 {id, status:EXPIRED, ...}` with `Inventory reservedAmount -= qty`; second `PATCH` on same `id` already `EXPIRED` → `200 {id, status:EXPIRED, alreadyTerminal:true}` `0` delta, `Logger.log reservation idempotent skip id=:id status=EXPIRED duplicates 1` + `INCR idempotency:duplicate:skipped:expiration`.
- `409 Conflict` conflicting cross-transition: `PATCH expire` on `COMPLETED` (`RESERVED→COMPLETED` already) → `409 {message:"Cannot transition COMPLETED -> EXPIRED"}` `0` delta.
- `404` not found, `403` not owner (unless Admin), `401` unauth.

Concurrent `expire` vs `expire` on same `id` → `FOR UPDATE Reservation` serializes → first `200 EXPIRED`, second `200` idempotent (not `409`).

### `POST /order/:id/complete` (`PATCH` alias) (Order)

Already `POST /order/:id/complete` `JwtGuard @Auth()` owner-or-Admin, `CompleteOrderDto` empty.

- `200 OK` idempotent `PENDING→COMPLETED` first `200 {status:COMPLETED}` `stock-=qty reserved-=qty`; second `POST` on already `COMPLETED` → `200 {status:COMPLETED, alreadyCompleted:true}` `0` delta, `Logger.log order complete idempotent skip` + `INCR idempotency:duplicate:skipped:complete`.
- `409` conflicting: `POST complete` on `CANCELLED|FAILED` → `409`.
- `404`/`403` as before.

Concurrent `complete` vs `complete` → `FOR UPDATE Order` then `Reservation` then sorted `Inventories` → first `200 COMPLETED`, second `200` idempotent.

**Swagger**: No new params; update `@ApiResponse({status:200, description:'COMPLETED or already COMPLETED idempotent'})` note.

---

## 3. Notification Worker — Dedup Envelope & Counter (Q5 B)

### Envelope (from OutboxEvent.payload persisted)
```json
{
  "eventId": "uuid // == OutboxEvent.id",
  "eventType": "order.created | order.completed | order.cancelled | reservation.expired",
  "version": 1,
  "occurredAt": "ISO",
  "correlationId": "uuid // from X-Request-Id or randomUUID()",
  "payload": { "orderId":"uuid", "userId":"uuid", "total": 2500, "items": [...], "reservationId":"uuid", "expiresAt":"ISO" }
}
```
`payload.eventId == id`, `payload.version==1`, `payload.correlationId` preserved, PII-free (`userId` only `email` via lookup).

### Worker Handle (dedup)
```ts
@EventPattern('order.created')
async handle envelope { eventId, eventType, version, correlationId, payload } {
  // idempotent guard
  const key = `notification:processed:${eventId}`; // or template+aggregate+userId for bulk
  const first = await this.cache.set(key, '1', 86400000, {nx:true}); // SET NX EX 24h
  if (!first) {
    this.logger.log(`notification duplicate eventId=${eventId} skipped`);
    await this.cache.incr('idempotency:duplicate:skipped:notification'); // or direct redis incr
    return; // ack 200
  }
  // else
  await this.emailProvider.send(to, subject, template, vars);
  await this.notificationLogRepo.save({userId: payload.userId, template, aggregateId: payload.orderId, eventId, provider: 'noop'});
  // fallback PG unique: ON CONFLICT (eventId) DO NOTHING
}
```
Bulk `sendBulk` per-user: `notification:send:sales:<campaignId>:<userId>` `SET NX` per user (re-scan full set per Q4 A).

**Responses**: Worker always `ACK` `200` after dedup check; transient `5xx` `EmailProvider` throws → Bull `attempts 3` `backoff exponential` retry, second attempt `SET NX 0` skip if already sent within window.

**Counter**: After dedup skip, also `CACHE_MANAGER INCR idempotency:duplicate:skipped:notification EX 86400` (or `Prometheus Counter inc({type:'notification'})`). Redis `ECONNREFUSED` → `Logger.warn Redis fail-open for idempotency counter` but still `return` (log ensures observability).

### `Idempotency Counter` (observability — Q5 B)

Keys `INCR` on every idempotent skip:
- `idempotency:duplicate:skipped:notification` — increment on duplicate `eventId` skip
- `idempotency:duplicate:skipped:expiration` — on `Reservation` `200 already terminal` same-transition
- `idempotency:duplicate:skipped:complete` — on `Order` `COMPLETED→COMPLETED`
- `idempotency:duplicate:skipped:cancel` — on `Reservation` `CANCELLED→CANCELLED`

Each `INCR` with `EX 86400` (daily window) for Grafana `rate`. `Redis` down → `warn` but not throw.

---

## 4. No New Public User Contract Beyond Admin Requeue

Checkout `POST /order/checkout {}` remains cart-only `201` cart-cleared, no `Idempotency-Key` header required (D8 state-based). `POST /admin/outbox/:id/requeue` is the sole new user-visible route in Phase 12; bulk requeue, `ProcessedEvent` table, `Idempotency-Key` header are out of scope.

---

## 5. Error Body

All errors via `AllExceptionsFilter`:
```json
{ "statusCode": 409|404|403|400|429, "message": "...", "timestamp": "ISO" }
```
`200` idempotent carries `{id, status, alreadyTerminal:true}` or `{status:COMPLETED}` for `complete`.

