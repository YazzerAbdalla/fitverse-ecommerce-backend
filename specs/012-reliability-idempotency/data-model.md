# Data Model: Reliability / Idempotency — Phase 12

**Feature**: `012-reliability-idempotency` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

Phase 12 adds **no new authoritative business table** beyond the optional audit `NotificationLog` and the admin requeue behavior on existing `OutboxEvent`. It hardens guards and Redis dedup keys.

---

## 1. Existing Entities — Hardened Guards (no schema change)

### Reservation
```
Reservation { @Entity('reservation') }
  id          uuid PK @PrimaryGeneratedColumn('uuid')
  userId      uuid FK → User.id ON DELETE CASCADE @Index
  orderId     uuid nullable FK → Order.id ON DELETE SET NULL @Index
  status      enum ReservationStatus {RESERVED, COMPLETED, EXPIRED, CANCELLED} @Index status,expiresAt composite already
  expiresAt   timestamptz @Index status,expiresAt
  createdAt   timestamptz @CreateDateColumn
  updatedAt   timestamptz @UpdateDateColumn
  items       OneToMany ReservationItem
  // indexes: status, userId, expiresAt, (status,expiresAt)
  // transition: RESERVED → COMPLETED|EXPIRED|CANCELLED only (validated via validateTransition)
  // idempotency guard (Phase 12 standardized Q2):
  //   SELECT Reservation WHERE id=:id FOR UPDATE
  //   if status != 'RESERVED' → return 200 {status, alreadyTerminal:true} 0 delta (if same-transition) or 409 if cross-transition (COMPLETED→EXPIRED)
  //   // only then lock sorted Inventories FOR UPDATE
```

### ReservationItem
```
ReservationItem { @Entity('reservation_item') }
  id            uuid PK
  reservationId uuid FK CASCADE
  inventoryId   uuid FK → Inventory.id ON DELETE CASCADE @Index
  quantity      int @Check quantity > 0
  @Unique(['reservationId','inventoryId'])
```

### Inventory
```
Inventory { @Entity('inventory') }
  id              uuid PK
  productId       uuid FK → Product.id ON DELETE CASCADE @Unique @Index
  stock           int @Check stock >= 0
  reservedAmount  int @Check reservedAmount >= 0 @Check reservedAmount <= stock
  createdAt / updatedAt
  // available getter: stock - reservedAmount (not column)
  // idempotency: UPDATE only inside FOR UPDATE Reservation status==RESERVED guard
  // CHECK 23514 → 409, triggers poison only on transient (D2)
```

### Order
```
Order { @Entity('order') }
  id        uuid PK
  userId    uuid FK CASCADE @Index
  status    enum OrderStatus {PENDING, COMPLETED, CANCELLED, FAILED} @Index
  total     int @Check total >= 0
  createdAt / updatedAt
  // guard: SELECT Order WHERE id=:id FOR UPDATE
  //   if status == COMPLETED → return 200 idempotent 0 delta (no Inventory UPDATE, no duplicate OutboxEvent)
  //   if status != PENDING → 409 already terminal 0 delta (CANCELLED|FAILED)
```

### OrderItem
```
OrderItem { @Entity('order_item') }
  id        uuid PK
  orderId   uuid FK CASCADE
  productId uuid FK RESTRICT
  quantity  int CHECK >0
  unit_price int CHECK >=0
  @Unique(['orderId','productId'])
```

---

## 2. OutboxEvent — Existing (Phase 11) + Hardened Requeue (Q1 B)

```
OutboxEvent { @Entity('outbox_event') }
  id                  uuid PK @PrimaryGeneratedColumn('uuid') // == payload.eventId
  eventType           varchar order.created|completed|cancelled|reservation.expired @Index
  aggregateType       varchar Order|Reservation @Index
  aggregateId         uuid @Index (no FK)
  payload             jsonb {version:1, eventId:id, eventType, occurredAt, correlationId, orderId, userId, ...} @Check payload->>'version' IS NOT NULL
  status              enum OutboxStatus {PENDING, PROCESSING, SENT, FAILED} @Index (composite status,nextRetryAt,createdAt)
  attempts            int default 0 @Check >=0
  nextRetryAt         timestamptz NOT NULL default NOW() @Index composite
  lastError           varchar(1000) nullable
  processingStartedAt timestamptz nullable // lease 30s
  createdAt           timestamptz @CreateDateColumn @Index createdAt DESC
  sentAt              timestamptz nullable
  // indexes: (status,nextRetryAt,createdAt) composite, eventType, aggregateId, createdAt DESC
  // lifecycle: PENDING→PROCESSING→SENT success; PROCESSING→PENDING retry with attempts++ nextRetryAt base*2^n cap 60s; PENDING→FAILED after 5 retained 30d
  // idempotency dedup key: payload.eventId == id
  // NEW behavior (Phase 12 Q1 B):
  //   requeue(manager, id):
  //     SELECT OutboxEvent WHERE id=:id FOR UPDATE
  //     if not found → 404
  //     if status != FAILED → 409 Already not FAILED (or 200 idempotent if status==PENDING)
  //     UPDATE status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL processingStartedAt=NULL
  //     // OUTSIDE transaction: Logger.log `outbox requeue id=:id by adminId`
  //   // Guard ensures publisher FOR UPDATE SKIP LOCKED will reclaim
```

---

## 3. New Optional Entity — NotificationLog (audit + fallback dedup)

```
NotificationLog { @Entity('notification_log') } // OPTIONAL V1 — if not migrated, Redis SET NX 24h is primary dedup (D7)
  id          uuid PK @PrimaryGeneratedColumn('uuid')
  userId      uuid FK → User.id ON DELETE CASCADE @Index
  template    varchar verify|reset|sales|new_product|order @Index
  subject     varchar nullable
  aggregateId uuid nullable @Index // e.g., orderId, campaignId, productId
  eventId     uuid @Index @Unique // OutboxEvent.id == payload.eventId dedup hard guard
  provider    varchar noop|smtp|ses|sendgrid default noop
  messageId   varchar nullable // provider response
  sentAt      timestamptz @CreateDateColumn @Index
  // indexes: (userId, sentAt), (template, sentAt), (eventId Unique), (aggregateId)
  // idempotency: INSERT ... ON CONFLICT (eventId) DO NOTHING → 0 rows means duplicate → skip EmailProvider.send
  // retention: same as outbox 30d purge (DELETE WHERE sentAt < NOW()-30d)
```

If `NotificationLog` is **not** shipped in Phase 12, the `SET NX` Redis key is the sole dedup (acceptable per spec Q3). The plan below assumes it **is** shipped for defense-in-depth but tasks mark it as optional.

---

## 4. Idempotency Redis Keys (ephemeral, not authoritative)

```
// Notification dedup (per spec FR-003 + D7)
notification:send:<template>:<aggregateId>:<userId> → '1'  EX 86400  SET NX  // bulk per-user
notification:processed:<eventId> → '1' EX 86400 SET NX // single envelope dedup alternative
// Duplicate skip counter (Q5 B)
idempotency:duplicate:skipped:notification → int  EX 86400 INCR // Redis INCR per type
idempotency:duplicate:skipped:expiration → int EX 86400
idempotency:duplicate:skipped:complete → int EX 86400
idempotency:duplicate:skipped:cancel → int EX 86400
// Expiration tick single-winner + poison (existing, Phase 5)
expiration:tick:lock → '1' EX 30 SET NX
expiration:poison:count → int EX 86400 INCR
expiration:poison:quarantined → '1' EX 86400 SET // quarantine flag
// Rate limit (existing)
rl:* → int EX windowMs
// Note: Redis FLUSHDB purges all — PG NotificationLog eventId Unique remains fallback
```

All keys via `CACHE_MANAGER` (`createKeyv` `REDIS_URL`) or direct `ioredis` `INCR`. On `SET NX`/`INCR` throw `ECONNREFUSED` → `Logger.warn Redis fail-open for idempotency <msg>` + allow operation once (availability over strict dedup).

---

## 5. Retry Policy (config, not entity)

```
// Outbox Publisher Layer A
OUTBOX_BATCH_SIZE=100
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_PROCESSING_LEASE_MS=30000 // reclaim PROCESSING older than 30s
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_RETRY_BASE_MS=1000
OUTBOX_RETRY_MAX_MS=60000
OUTBOX_RETENTION_DAYS=30
Formula: nextRetryAt = NOW() + min(base*2^(attempts-1), cap)

// Expiration Layer B
EXPIRATION_CRON=*/30 * * * * * // repeat 30s
EXPIRATION_MAX_RETRIES=3 // Bull attempts 3 then poison quarantine 24h
// Poison counts only transient DB failures per D2 (200/404 not counted)

// Notifications Layer C
NOTIFICATION_BULL_ATTEMPTS=3
NOTIFICATION_BULL_BACKOFF=exponential // base 1000
// Layer D business HTTP: no server retry, client idempotent via status guard
```

All via `ConfigService`, clamped `>=1` max. `Idempotency TTL` `IDEMPOTENCY_TTL=86400` (24h) for `SET NX`.

---

## 6. State Transitions — Idempotent Guards Summary

```
Reservation RESERVED → EXPIRED:  guard if status != RESERVED → 200 same-transition 0 delta (Q2) else FOR UPDATE sorted Inventories → reserved-=qty → EXPIRED
Reservation RESERVED → CANCELLED: same guard → 200 0 delta if already CANCELLED; 409 if already COMPLETED|EXPIRED (cross)
Reservation RESERVED → COMPLETED: via Order COMPLETED path, guard if reservation.status != RESERVED → 409 (complete vs expire loser)
Order PENDING → COMPLETED: guard if order.status == COMPLETED → 200 idempotent 0 delta; if status != PENDING → 409; only then FOR UPDATE Reservation/Inventories → stock-=qty reserved-=qty
Order PENDING → CANCELLED/FAILED: same guard pattern
Outbox PENDING/PROCESSING → SENT: FOR UPDATE SKIP LOCKED batch 100 → PROCESSING → emit → SENT
Outbox FAILED → PENDING: Admin PATCH requeue FOR UPDATE WHERE status=FAILED → PENDING attempts=0 (Q1 B)
Notification eventId: SET NX → if 0 → Logger.log duplicate + INCR idempotency:duplicate:skipped:* → return (idempotent)
```

---

## 7. Validation Rules

- `Inventory.stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock` (`@Check` DB + `23514 → 409`)
- `ReservationItem.quantity >0`, `@Unique reservationId+inventoryId`
- `OrderItem.quantity>0`, `unit_price>=0`, `@Unique orderId+productId`
- `Reservation.status` enum, `Order.status` enum, `OutboxEvent.status` enum
- `OutboxEvent.payload->>'version' IS NOT NULL` `CHECK`
- `NotificationLog.eventId @Unique` if table exists
- DTOs: `RequeueParams { @IsUUID id }`, no body; `Admin` guard via `@Auth(Admin)`

---

## 8. Indexes

- `Reservation`: `(status, expiresAt)`, `userId`, `status`, `orderId`
- `Inventory`: `productId @Unique`
- `Order`: `userId`, `status`
- `OutboxEvent`: `(status, nextRetryAt, createdAt)` composite (publisher), `eventType`, `aggregateId`, `createdAt DESC`
- `NotificationLog` (if added): `userId`, `eventId @Unique`, `aggregateId`, `(template, sentAt)`

---

## 9. Notes

- Phase 12 is hardening, not new business state — `synchronize:false` stays, no bulk migration beyond optional `NotificationLog`. `OutboxEvent` already migrated in Phase 11.
- `available = stock - reservedAmount` never stored.
- `PATCH /admin/outbox/:id/requeue` is the only new endpoint; bulk requeue deferred.
