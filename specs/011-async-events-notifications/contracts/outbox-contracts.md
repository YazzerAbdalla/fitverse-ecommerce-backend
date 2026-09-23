# Contracts: Transactional Outbox + RabbitMQ Events (Phase 11)

**Feature**: `011-async-events-notifications` | **Spec**: [spec.md](../spec.md) | **Data Model**: [data-model.md](../data-model.md) | **Date**: 2026-09-23

## 1. Event Envelope (Outbox → RabbitMQ)

Every `OutboxEvent` row maps to one `client.emit(eventType, payload)` where `payload` is the persisted `OutboxEvent.payload` **byte-equal** (research D7). Wrapper envelope is the payload itself (no second `envelope.payload` nesting) unless `publisher` wraps as `{eventId, eventType, version, occurredAt, correlationId, payload}` — both are accepted but V1 **payload itself contains those fields** so `client.emit(eventType, payload)` suffices.

```json
{
  "version": 1,
  "eventId": "uuid (== outbox_event.id)",
  "eventType": "order.created | order.completed | order.cancelled | reservation.expired",
  "occurredAt": "2026-09-23T12:00:00.000Z (ISO, payload occurredAt == OutboxEvent created from NOW())",
  "correlationId": "uuid from X-Request-Id / X-Correlation-Id or crypto.randomUUID() at controller",
  "…businessFields": {}
}
```

### 1.1 order.created

Trigger: `src/modules/order/order-checkout.service.ts:44` `DataSource.transaction` `Order PENDING + Reservation RESERVED + OutboxEvent INSERT`.

```json
{
  "version": 1,
  "eventId": "uuid",
  "eventType": "order.created",
  "occurredAt": "ISO",
  "correlationId": "uuid",
  "orderId": "uuid (aggregateId)",
  "userId": "uuid (JWT sub)",
  "total": 2500,
  "currency": "usd",
  "items": [{"productId": "uuid", "inventoryId": "uuid", "quantity": 2, "unit_price": 1250}],
  "reservationId": "uuid",
  "expiresAt": "ISO (now+15m)",
  "createdAt": "ISO"
}
```

**Headers**: `X-Request-Id` or `X-Correlation-Id` from request forwarded as `correlationId` in payload; publisher preserves.

### 1.2 order.completed

Trigger: `src/modules/order/order-completion.service.ts:88` same transaction `PENDING→COMPLETED` `stock-=qty reserved-=qty`.

```json
{
  "version": 1,
  "eventId": "uuid",
  "eventType": "order.completed",
  "occurredAt": "ISO",
  "correlationId": "uuid",
  "orderId": "uuid",
  "userId": "uuid",
  "previousStatus": "PENDING",
  "newStatus": "COMPLETED",
  "reservationId": "uuid",
  "items": [{"inventoryId": "uuid", "quantity": 2}],
  "completedAt": "ISO"
}
```

Idempotent guard: `COMPLETED→COMPLETED` creates **no** new `order.completed` row (FR-004).

### 1.3 order.cancelled

Trigger: explicit cancel endpoint or expiration auto-cancel `PENDING→CANCELLED|FAILED` `reserved-=qty` (FR-005/006).

```json
{
  "version": 1,
  "eventId": "uuid",
  "eventType": "order.cancelled",
  "occurredAt": "ISO",
  "correlationId": "uuid",
  "orderId": "uuid",
  "userId": "uuid",
  "previousStatus": "PENDING",
  "newStatus": "CANCELLED",
  "reason": "user | failed | expired",
  "reservationId": "uuid | null"
}
```

`reason:'expired'` when from `ReservationExpirationService`.

### 1.4 reservation.expired

Trigger: `src/modules/reservation/reservation-expiration.service.ts:184` per-candidate `RESERVED→EXPIRED` `reserved-=qty` (+ optional `order.cancelled`).

```json
{
  "version": 1,
  "eventId": "uuid",
  "eventType": "reservation.expired",
  "occurredAt": "ISO",
  "correlationId": "uuid (new UUID for expiration job)",
  "reservationId": "uuid (aggregateId)",
  "userId": "uuid",
  "orderId": "uuid | null",
  "items": [{"inventoryId": "uuid", "quantity": 2}],
  "expiresAt": "ISO",
  "expiredAt": "ISO"
}
```

**PII**: None — `userId` only, no `email`. Worker resolves email via `usersRepository.findOne(userId)` (Q2).

### 1.5 Outbox Publisher Contract

- **Claim**: `SELECT ... WHERE (status='PENDING' AND nextRetryAt<=NOW()) OR (status='PROCESSING' AND processingStartedAt < NOW()-'30 seconds') ORDER BY createdAt ASC, id ASC LIMIT :batchSize FOR UPDATE SKIP LOCKED` → `UPDATE status='PROCESSING', processingStartedAt=NOW()`.
- **Publish**: `await lastValueFrom(client.emit(eventType, payload))` (RMQ `notification_queue` durable, pattern `eventType` as routing, `RABBITMQ_URL` existing `ClientsModule` singleton). No second RMQ connection.
- **Ack success**: `UPDATE outbox_event SET status='SENT', sentAt=NOW(), lastError=NULL, processingStartedAt=NULL, nextRetryAt=NOW() WHERE id=:id`.
- **Nack failure**: `attempts=attempts+1, lastError=LEFT(msg,1000), nextRetryAt=NOW()+ LEAST(60000, 1000*2^(attempts-1)), status = CASE WHEN attempts>=5 THEN 'FAILED' ELSE 'PENDING' END, processingStartedAt=NULL`.
- **Empty `RABBITMQ_URL`**: Log `RABBITMQ_URL not set, skipping publish` → leave `PENDING`, no `attempts` bump.

### 1.6 Consumer Contract (NotificationWorker)

- **Subscribe**: `@EventPattern('order.created')`, `@EventPattern('order.completed')`, `@EventPattern('order.cancelled')`, `@EventPattern('reservation.expired')` via `ClientsModule` microservice transport (or direct `@EventPattern` without BullMQ bridge — V1 log-only).
- **Handler**: `handle({eventId, eventType, version, occurredAt, correlationId, ...})` MUST log `Logger.log notification received <eventType> eventId=<eventId> correlationId=<id>` (PII-free) and return ack. No `Inventory`/`Order` mutation; duplicate `eventId` → `Logger.log duplicate eventId=<id> already processed` (at-least-once tolerant).
- **BullMQ vs RMQ retries**: Publisher `maxAttempts 5` (outbox→RMQ) independent from consumer `BullModule` `notifications` `attempts 3` (future `handle` throw). Spec FR-012.

### 1.7 Admin Ops (optional, for FAILED requeue)

- `GET /admin/outbox?status=FAILED&eventType=order.created&page=1&limit=20` — `200 {data:OutboxEvent[], meta}` paginated `createdAt DESC`, `Auth(Admin)`, owner-scoped not needed. `@ApiResponse 200`. `@Index` on `status`.
- `PATCH /admin/outbox/:id/requeue` — `200` resets `status='PENDING' attempts=0 nextRetryAt=NOW() lastError=NULL` where `status='FAILED'` (`Auth(Admin)`). `404` if not `FAILED`, `409` if not found.

These are not required for SC pass but documented for ops (Phase 12 cleanup may add `DELETE /admin/outbox/cleanup?before=30d`).

## 2. HTTP Contracts (unchanged business APIs, additive outbox)

Business routes unchanged (`ValidationPipe` + `Auth` + `RateLimitGuard` outermost):

- `POST /order/checkout` `201 {order, reservation}` + side-effect `OutboxEvent order.created PENDING` (no new header). `400` empty cart / `409` insufficient / `429` rate-limit → zero outbox rows.
- `POST /order/:id/complete` (and `PATCH` alias) `200 {order, reservation}` + `OutboxEvent order.completed PENDING` same commit; idempotent `COMPLETED→COMPLETED` `200` with no duplicate outbox.
- `POST /order/:id/cancel` (if exposed) `200 {order}` + `order.cancelled PENDING`.
- `GET /order/:id`, `GET /order` paginated, `GET /inventory/:productId` — zero outbox side-effect.

Outbox is not exposed as public user API — publisher is background.

## 3. Error Contracts

- Publisher failure never becomes `HTTP 500` (caught, `Logger.warn outbox publish failed id=<id> eventType=<t> attempts=<n> nextRetryAt=<iso>: <msg>`). `AllExceptionsFilter` serializes business `400/404/409/429` as `{statusCode, message, timestamp}` unchanged.
- `OutboxEvent` `payload.version` missing → `CHECK` violation `23514` → mapped `409` if inserted via service validation before save (service validates).

## 4. Versioning

- `version:1` in every `payload`. Consumers `if (payload.version !== 1) Logger.warn unsupported version`. Additive fields (e.g., `currency`) allowed without breaking V1; Renames require `version:2` new `eventType` or `eventType.v2` — not in V1.
- `correlationId` opaque UUID, not used for dedup.

## 5. Example E2E (contract verification)

```http
POST /order/checkout HTTP/1.1
Authorization: Bearer <jwt>
X-Request-Id: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
{}  // cart-only

HTTP/1.1 201
{"order":{"id":"o1","status":"PENDING","total":2500},"reservation":{"id":"r1","expiresAt":"..."}}

-- async after 1s poll --
RMQ notification_queue: pattern='order.created' body={"version":1,"eventId":"<outbox.id==payload.eventId>","eventType":"order.created","occurredAt":"...","correlationId":"550e8400-...","orderId":"o1","userId":"u1","total":2500,"items":[...],"reservationId":"r1"}
```

Capture via mocked `ClientProxy` in tests: `expect(client.emit).toHaveBeenCalledWith('order.created', expect.objectContaining({eventId: outbox.id, version:1, correlationId: '550e...'}))`.
