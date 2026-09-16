# Data Model — Reservation Expiration Cleanup (Phase 5)

**Branch**: `006-reservation-expiration-cleanup` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new PostgreSQL tables, columns, indexes, or CHECKs in Phase 5. Model reuses Phase 1-4 entities and adds BullMQ (Redis) queue state and a minimal RabbitMQ domain event payload. Poison retry is managed in-service memory (or BullMQ job attempts), not via PG column.

---

## 1. Entities (existing, unchanged PG schema)

### Inventory (`src/modules/inventory/entities/inventory.entity.ts`)

```text
Inventory {
  id: uuid PK
  productId: uuid FK Product.id ON DELETE CASCADE, UNIQUE, INDEX
  stock: int default 0, CHECK stock>=0
  reservedAmount: int default 0, CHECK reservedAmount>=0, CHECK reservedAmount<=stock
  createdAt: timestamptz, updatedAt: timestamptz
  derived: available = stock - reservedAmount
}
```

- Mutations in this phase (worker): `reservedAmount -= qty` per `ReservationItem`, `stock` unchanged (FR-003, constitution III). Multi-item: all items atomically per reservation.
- Locks: `FOR UPDATE` on each referenced `Inventory` row in sorted `inventoryId` order (D3), inside per-reservation `EntityManager` transaction.
- Backstop: DB `CHECK`s; violation (`reservedAmount - qty < 0`) → `QueryFailedError` 23514 → caught → `ConflictException` → rollback single candidate, log, retry up to `EXPIRATION_MAX_RETRIES=3` then skip (D7).

### Reservation (`src/modules/reservation/entities/reservation.entity.ts`)

```text
Reservation {
  id: uuid PK
  userId: uuid FK User.id ON DELETE CASCADE, INDEX
  orderId: uuid nullable FK Order.id ON DELETE SET NULL, INDEX nullable
  status: enum RESERVED|COMPLETED|EXPIRED|CANCELLED default RESERVED, INDEX
  expiresAt: timestamptz, INDEX + composite INDEX (status, expiresAt) — required for scan
  createdAt: timestamptz, updatedAt: timestamptz
  items: ReservationItem[] OneToMany cascade
}
```

- Status lifecycle via worker: `RESERVED -> EXPIRED` only (FR-005). Worker scan predicate is `WHERE status='RESERVED' AND expiresAt <= NOW()` (FR-001) ordered `ORDER BY expiresAt ASC, id ASC LIMIT :batchSize`. Scan is **outside** the per-reservation `FOR UPDATE` transaction (FR-008); per-candidate transaction then `SELECT ... FOR UPDATE` the `Reservation` row and verifies `status===RESERVED` after lock — if not, idempotent skip (FR-005, no inventory change).
- Manual `PATCH /:id/expire` remains immediate override (no `expiresAt` check, FR-004); worker is the only path that enforces `expiresAt <= NOW()`.
- `DEFAULT_TTL_MS = 15m` unchanged; worker never mutates `expiresAt` generation.

### ReservationItem (`src/modules/reservation/entities/reservation-item.entity.ts`)

```text
ReservationItem {
  id: uuid PK
  reservationId: uuid FK Reservation.id ON DELETE CASCADE, INDEX
  inventoryId: uuid FK Inventory.id, INDEX
  quantity: int, CHECK quantity>0, UNIQUE (reservationId, inventoryId)
}
```

- `quantity` is the source of truth for `reservedAmount` delta; worker reads items from locked `Reservation` (`relations:{items:true}`), not client payload (FR-009).

### Order (read-only)

```text
Order { id: uuid PK, userId: uuid, status: OrderStatus, total, ... } // src/modules/order/entities/order.entity.ts
```

- Not touched by expiration; only used for `complete` path. Expiration never reads or mutates `Order`.

---

## 2. Non-PG State

### BullMQ queue (`reservation-expiration`) — Redis

```text
Queue: reservation-expiration (BullMQ, backing Redis)
  jobId: reservation-expiration-tick (singleton, Q4 D4)
  repeat: every EXPIRATION_INTERVAL_MS (default 30000ms) or EXPIRATION_CRON / BULLMQ_REPEAT
  concurrency: 1 (@Processor concurrency guard, non-overlapping ticks)
  enabled: EXPIRATION_ENABLED (boolean, default true) — when false, processor short-circuits without scan
```

- Not a PG entity; state lives in Redis (`ioredis` via `REDIS_URL`). Survives Nest restarts (repeat persisted). Singleton via `jobId` ensures only one enqueued tick at a time.

### RabbitMQ event `reservation.expired` — transient

```text
Event: reservation.expired (RMQ, queue: notification_queue via NOTIFICATION_SERVICE)
  payload: {
    reservationId: uuid,
    userId: uuid,
    expiredAt: ISO string (commit time),
    expiresAt: ISO string (original field),
    inventoryIds: uuid[],
    items: { inventoryId: uuid, quantity: int }[]
  }
```

- Published **only after** per-reservation `COMMIT` (FR-003/Q3), via `ClientProxy.emit('reservation.expired', payload)` with existing `Transport.RMQ` (`RABBITMQ_URL`, `queue: notification_queue`). Publish failure is `try/catch` logged `error`, not rolled back. No PG outbox in Phase 5.

### Poison retry tracking — in-service memory

```text
PoisonMap: Map<reservationId, failureCount>
  key: reservationId uuid
  value: failureCount int (0..EXPIRATION_MAX_RETRIES)
  reset: on successful EXPIRED transition, delete key
  skip: when count >= EXPIRATION_MAX_RETRIES (default 3), skip further auto-retries until manual fix or data corrected
```

- In-memory, **reset on process restart** (acceptable for Phase 5, per analysis U1) — restart resets `failureCount` to 0 and poison will be retried up to N again; persistent alternative is BullMQ `attempts` but not required. Every retry logged (`warn`), final skip logged `error`. Every candidate still scanned each tick; service-side `skipSet` filters poison after N failures. Documents at-most-N-per-incarnation semantics.

---

## 3. Transaction Models

### Per-candidate expiration (inside `processExpiredBatch` loop)

```
BEGIN  // dataSource.transaction(async manager => expireOne(manager, reservationId))
  SELECT reservation WHERE id = :id FOR UPDATE                  // pessimistic_write, no relations outer join
  if not found → 404
  SELECT reservation WHERE id = :id WITH relations {items: true} // still locked via tx
  if status != RESERVED → skip (idempotent, no inventory lock, return {skipped:1}, do not throw)
  sortedIds = [...new Set(items.map(i=>i.inventoryId))].sort()  // D3 deterministic
  if sortedIds.length > 0:
    SELECT inventory WHERE id IN (:sortedIds) FOR UPDATE          // pessimistic_write
    if count != sortedIds.length → 404 Inventory missing → rollback, throw (retry counted)
  for each item:
    inv.reservedAmount -= item.quantity   // stock unchanged
    manager.save(inv)                     // CHECK backstop, 23514 → ConflictException
  reservation.status = EXPIRED
  manager.save(reservation)
COMMIT // or ROLLBACK on any throw, no partial state

// outside tx, if COMMIT succeeded:
try { client.emit('reservation.expired', payload) } catch(e) { logger.error(...) }
```

- Controller for manual expire still wraps in `dataSource.transaction(manager => service.expire(manager,id))` per Phase 4; worker reuses same `transitionWithInventoryInternal` path but with `checkOwner=false`.

### Batch scan (outside per-candidate tx)

```
SELECT id FROM reservation
 WHERE status = 'RESERVED' AND expiresAt <= NOW()
 ORDER BY expiresAt ASC, id ASC
 LIMIT :batchSize  // EXPIRATION_BATCH_SIZE, default 10

for each id in ids:
  try { await transaction(expireOne(manager,id)) }
  catch(e) { failureCountMap[id] = (failureCountMap[id]||0)+1; logger.warn/error; if count >= MAX_RETRIES skipSet.add(id); continue; }
  // on success: delete failureCountMap[id], publish RabbitMQ
return {scanned: ids.length, expired: successCount, skipped, failed, retried}
```

- Scan is **outside** `FOR UPDATE` (FR-008) to keep lock window short. No `SKIP LOCKED` required because singleton + per-reservation `FOR UPDATE` already handles races; using `SKIP LOCKED` would be an optional optimization only if it preserves ordering.

---

## 4. Validation & Error Table (expiration path)

| Condition | Check Location | Error / Handling | Inventory Effect | Status Effect | Retry |
|-----------|---------------|------------------|------------------|---------------|-------|
| `status` after `FOR UPDATE` is `COMPLETED`/`EXPIRED`/`CANCELLED` | inside per-candidate tx after lock | Skip idempotent — return `{skipped:1}`, log `debug`, no throw | none | none | no retry |
| `Inventory` row missing (deleted between create and expire) | after `FOR UPDATE` Inventory, `length != sortedIds.length` | `404 Inventory <id> not found` → rollback, log `warn`, rethrow | none (rollback) | none | retry up to N, then skip (D7) |
| `reservedAmount - qty < 0` hits `CHECK 23514` | `manager.save(Inventory)` | caught `QueryFailedError` (code 23514/`CHK_`) → rethrow `ConflictException(409)` → rollback | rollback | none | retry up to N, then skip (D7) |
| `Reservation` not found (id from scan deleted concurrently) | initial `FOR UPDATE` Reservation | `404` → rollback, log `warn` | none | none | counted as failed, batch continues |
| Manual `PATCH /:id/expire` by non-admin | `@Auth(Admin)` guard on controller | `403 Forbidden` | none | none | n/a |
| RabbitMQ `emit` fails after commit | outside tx | `catch` log `error`, do not roll back | already committed | already EXPIRED | not retried (at-most-once) |

## 5. Indexes / Constraints (existing, no new PG DDL)

- `Reservation`: `@Index(['userId'])`, `@Index(['status'])`, `@Index(['expiresAt'])`, `@Index(['status','expiresAt'])` — composite is the required scan index, verified via `EXPLAIN` SC-008.
- `ReservationItem`: `@Index(['reservationId'])`, `@Index(['inventoryId'])`, `@Unique(['reservationId','inventoryId'])`, `@Check quantity>0`.
- `Inventory`: `@Index(['productId'])`, `@Unique(['productId'])`, `@Check stock>=0`, `@Check reservedAmount>=0`, `@Check reservedAmount<=stock`.
- `BullMQ` state is in Redis, not PG; no PG migration expected (D8). If a needed PG index is proven missing, add via `src/migration/` with `synchronize:false`.

## 6. Clarification Integration Points (Q1-Q5)

| Q | Spec Clarification | Data-Model Impact |
|---|-------------------|-------------------|
| Q1 | 60s SLA (tick 30s) | Scan interval `30s` default; SC-001/SC-007 bound to within 60s of `expiresAt`; `EXPIRATION_INTERVAL_MS` default `30000` |
| Q2 | BullMQ repeat scheduler | BullMQ queue `reservation-expiration` repeat, `@Processor` model, `Bulk` not needed |
| Q3 | RabbitMQ `reservation.expired` post-commit | Transient event payload `{reservationId, userId, ...}` after commit, not inside tx |
| Q4 | Singleton `concurrency:1` | Queue `jobId` singleton + processor `concurrency:1`; `FOR UPDATE` remains backstop |
| Q5 | Poison retry N=3 then skip, log every retry | In-memory `Map<id,count>` + `skipSet`, `EXPIRATION_MAX_RETRIES` env, error table retry column |

## 7. Invariants Preserved

- `stock >=0` & `reservedAmount >=0` & `reservedAmount <= stock` at every commit (DB `CHECK`).
- `available = stock - reservedAmount` derived.
- `quantity >0` per `ReservationItem`.
- Only `RESERVED->EXPIRED` mutates `reservedAmount` (stock unchanged) and only once per reservation (idempotent skip on reprocessing).
- Scan predicate `expiresAt <= NOW()` (inclusive, `timestamptz`, Postgres `NOW()` server time) — boundary `== NOW()` is eligible.

