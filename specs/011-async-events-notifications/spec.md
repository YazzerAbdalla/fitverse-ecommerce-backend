# Feature Specification: Asynchronous Events / Notifications — Transactional Outbox

**Feature Branch**: `011-outbox-transaction`  
**Created**: 2026-09-23  
**Status**: Draft (Refactored to Outbox 2026-09-23)  
**Input**: User description: "phase 11 in the plan" + refactor to **Transactional Outbox Pattern** (PostgreSQL `OutboxEvent` inside business transaction, async publisher to RabbitMQ)  
**Source**: `docs/plan.md` Phase 11 (§11), constitution I/III/IV (PostgreSQL authoritative), existing `src/app.module.ts` (`ClientsModule NOTIFICATION_SERVICE` RMQ + `BullModule` shared `REDIS_URL`), `src/modules/order/order-checkout.service.ts` (checkout `DataSource.transaction` `FOR UPDATE`), `src/modules/order/order-completion.service.ts` (`PENDING→COMPLETED` `stock-=qty`), `src/modules/reservation/reservation-expiration.service.ts` (`processExpiredBatch` `FOR UPDATE` + prior `reservation.expired` direct emit — to be replaced), `docs/architecture/inventory-reservation.md` (publish-after-commit superseded by outbox)

---

## 1. Overview

Phases 1–10 built a transactionally correct pipeline (`Inventory` 1-1 `CHECK`, `Reservation` `FOR UPDATE` `RESERVED→COMPLETED|EXPIRED|CANCELLED`, `Order` checkout-only `PENDING→COMPLETED|CANCELLED|FAILED`, caching Phase 9, rate limiting Phase 10) with a single prior async attempt: `ReservationExpirationService` emitted `reservation.expired` directly to RabbitMQ **after** commit (at-most-once, fail-open → event lost).

This spec **refactors Phase 11 to the Transactional Outbox Pattern** per user directive. The prior `EventsService` publish-after-commit is replaced:

```text
Before (lost event on broker down):
Business DB Transaction → COMMIT → RabbitMQ publish → failure → event lost

After (outbox, durable):
┌──────────── PostgreSQL Transaction ────────────┐
│  Business state change (Order/Reservation/     │
│  Inventory/Cart)                               │
│  + OutboxEvent INSERT (PENDING)                │
└──────────────────── COMMIT ────────────────────┘
                         ↓
                  Outbox Publisher (poll + FOR UPDATE SKIP LOCKED)
                         ↓
                    RabbitMQ (existing NOTIFICATION_SERVICE)
                    ↙       ↘
                success    failure
                   ↓          ↓
                 SENT       retry (exponential backoff)
                              ↓
                         max attempts
                              ↓
                           FAILED (retained)
```

**Critical invariant (P0):** *If the business transaction commits, the corresponding domain event MUST exist in `outbox_event` (`status=PENDING`).* If the business transaction rolls back, no outbox row exists. RabbitMQ is **never** called inside the business transaction; its availability does not affect the HTTP `200/201` as long as PostgreSQL commits. The bridge from outbox → RabbitMQ is at-least-once (duplicate possible → consumers idempotent), retries are durable, `FAILED` events are retained for ops.

**V1 events (unchanged contracts, now persisted):** `order.created`, `order.completed`, `order.cancelled` (covers `FAILED` via `reason`), `reservation.expired`. Each carries `version:1` + `correlationId` (from `X-Request-Id` or `randomUUID()`), PII-free.

**Thin change:** new `OutboxEvent` entity + `OutboxService` (transactional `createEvent(manager, ...)`) used inside `OrderCheckoutService`, `OrderCompletionService`, (future) `OrderCancellationService`, and `ReservationExpirationService`; new `OutboxPublisher` (BullMQ-scheduled or `setInterval` poll, `FOR UPDATE SKIP LOCKED`, batch `100` configurable, lease, exponential backoff, `SENT/FAILED` lifecycle); RabbitMQ publish now reads persisted payload (no reconstruction); `NotificationWorker` consumption unchanged except idempotency tolerance of duplicates.

### Goal

Non-critical side effects are durably buffered in PostgreSQL and delivered even through RabbitMQ outages, without holding `FOR UPDATE` locks for I/O and without losing events. — `docs/plan.md` Phase 11 Exit Criteria refined: *Asynchronous failures do not roll back committed transactions, and committed transactions always have a corresponding outbox event that is eventually published (at-least-once).*

---

## 2. User Scenarios & Testing

### User Story 1 — Checkout atomically creates Order + OutboxEvent and survives RabbitMQ outage (Priority: P1)

A shopper calls `POST /order/checkout {}` with non-empty cart. Inside **one** `DataSource.transaction` the service locks sorted `Inventory` rows `FOR UPDATE`, checks `available = stock - reservedAmount >= qty`, increments `reservedAmount`, creates `Order PENDING` + `OrderItem`s (snapshot `unit_price`), creates `Reservation RESERVED (expiresAt now+15m, orderId)`, clears cart, **and** inserts `OutboxEvent` `{eventType:'order.created', aggregateType:'Order', aggregateId:orderId, payload:{version:1, eventId, eventType, occurredAt, correlationId, orderId, userId, total, items:[{productId, inventoryId, quantity, unit_price}], reservationId, expiresAt, createdAt}, status:'PENDING', attempts:0, nextRetryAt: NOW()}` using the **same `EntityManager`**, then commits. After commit the HTTP response returns `201 {order, reservation}` **without** touching RabbitMQ. Independently, `OutboxPublisher` polls `status=PENDING AND nextRetryAt<=NOW()` (and `PROCESSING` lease expired), claims with `FOR UPDATE SKIP LOCKED` → `PROCESSING`, publishes the persisted payload to `NOTIFICATION_SERVICE`, and marks `SENT` (`sentAt=NOW()`). If RabbitMQ is down, the checkout still returns `201` and the outbox row stays `PENDING` → retries; no event is lost.

**Why this priority**: Load-bearing invariant. If outbox insert were outside transaction or RabbitMQ were inside it, a commit without event (or a broker-induced rollback) would violate P0.

**Independent Test**: With `OutboxEvent` repository mocked or real PG + mocked `ClientProxy` (`emit` throw), call `OrderCheckoutService.checkout` via `Test.createTestingModule` with real `DataSource.transaction` → assert single commit creates both `Order PENDING` and `OutboxEvent PENDING` with same `orderId` (`SELECT outbox_event WHERE aggregateId=:orderId AND eventType='order.created'`). Then simulate `DataSource.transaction` rolling back (throw `Insufficient available`) → assert zero `Order` and zero `OutboxEvent`. With `ClientProxy.emit` success → publisher batch marks `SENT`; with throw → publisher marks `attempts=1 nextRetryAt=NOW()+1s` still `PENDING/PROCESSING→PENDING` for retry, HTTP already `201`.

**Acceptance Scenarios**:
1. **Given** cart `qty 2` `available 10`, **When** `POST /order/checkout` commits, **Then** `SELECT Order WHERE id=:id` `PENDING` **and** `SELECT OutboxEvent WHERE aggregateId=:id AND eventType='order.created'` `status PENDING` `attempts 0` `payload.eventId == outbox.id` `payload.correlationId` present, and no `client.emit` was called inside the transaction (grep `client.emit` inside `manager` callback 0, publisher will emit later).
2. **Given** RabbitMQ down (`client.emit` mocked `throw ECONNREFUSED`), **When** same checkout completes, **Then** HTTP `201` still, `OutboxEvent` remains `PENDING` (or `PROCESSING→PENDING` after claim attempt) with `attempts=1 lastError contains ECONNREFUSED nextRetryAt > NOW()`, and `GET /order/:id` `PENDING`.
3. **Given** checkout validation fails (`400` empty cart or `409` insufficient), **When** transaction rolls back, **Then** zero `OutboxEvent` rows for that `orderId`.

---

### User Story 2 — Order completion/cancellation atomically creates outbox events; expiration creates one or two events per committed reservation (Priority: P1)

Completing `POST /order/:id/complete` (`PENDING→COMPLETED` `stock-=qty reserved-=qty` + `Reservation RESERVED→COMPLETED`) creates `order.completed` inside the **same** transaction as the status and inventory mutations. Cancelling `PENDING→CANCELLED|FAILED` (user cancel or explicit service) creates `order.cancelled {reason:'user'|'failed'|'expired'}` inside same transaction. For expiration, for each **actually transitioned** reservation: `RESERVED→EXPIRED` `reserved-=qty` (+ optional `Order PENDING→CANCELLED` auto-cancel) the transaction inserts `reservation.expired` **and**, only if an order was cancelled, additionally inserts `order.cancelled {reason:'expired'}`. All inserts use the transaction's `EntityManager`. If `Reservation` was already `EXPIRED`/`COMPLETED`, no new `reservation.expired` event is inserted (and if `Order` already terminal, no `order.cancelled`).

**Why this priority**: Second inventory-mutating path. Without atomic outbox, a sale could commit without `order.completed` (downstream lost) or expiration could double-emit.

**Independent Test**: `OrderCompletionService.complete(manager, userId, orderId)` with injected `OutboxService` → verify inside `dataSource.transaction` spy `manager.getRepository(OutboxEvent).save` called with `order.completed`, and after outer `commit` the row is `PENDING`. Throw inside transaction → zero outbox. For expiration, `ReservationExpirationService.processExpiredBatch` with 2 expired `RESERVED` (one with `orderId`, one without) → after ticks verify `outbox_event` counts `2 reservation.expired` + `1 order.cancelled`, and duplicate tick with same candidates `0` new events (idempotent guard).

**Acceptance Scenarios**:
1. **Given** `Order PENDING` + `Reservation RESERVED`, **When** `POST /order/:id/complete` commits, **Then** single atomic commit mutates `Order COMPLETED`, `Inventory stock 10→8 reserved 2→0`, `Reservation COMPLETED`, **and** `OutboxEvent order.completed {orderId,userId,reason?}` `PENDING`; publisher later emits `order.completed` and marks `SENT`.
2. **Given** expiration batch finds `Reservation RESERVED` with `orderId` still `PENDING`, **When** `processExpiredBatch` commits per-candidate, **Then** transaction creates `reservation.expired {reservationId,userId,orderId,items,expiresAt,expiredAt,version,correlationId}` `PENDING` **and** `order.cancelled {orderId,reason:'expired'}` `PENDING` atomically; if order already `COMPLETED`, second event omitted.
3. **Given** `POST /order/:id/complete` idempotent replay (`COMPLETED→COMPLETED`), **When** second call commits, **Then** `Order` stays `COMPLETED` no inventory re-mutation, and **no** new `order.completed` outbox row (guard `if already COMPLETED return` → no insert), proving no duplicate on `429`/retry.

---

### User Story 3 — OutboxPublisher claims, publishes, retries with lease and never blocks business transactions (Priority: P1)

A background `OutboxPublisher` (BullMQ repeat or `setInterval` poll, shared `REDIS_URL`/`RABBITMQ_URL` via `ConfigService`) periodically claims a batch (`100` configurable, `status=PENDING OR (PROCESSING AND processingStartedAt < NOW() - lease)`, `nextRetryAt<=NOW()`, ordered `createdAt ASC`, `FOR UPDATE SKIP LOCKED`) → sets `PROCESSING` (`processingStartedAt=NOW()`, `attempts` not yet incremented), publishes the **persisted** `payload` (containing `eventId/outbox.id`, `eventType`, `version`, `occurredAt`, `correlationId`) to `NOTIFICATION_SERVICE` (`client.emit(eventType, envelope)`), then on success `status=SENT sentAt=NOW() lastError=NULL`, on failure `attempts++ lastError=msg nextRetryAt=NOW()+exp(attempts)` (e.g., `+1s,+2s,+4s,+8s,+16s`, base delay configurable) and reverts to `PENDING` (or keeps `PROCESSING` until next claim). After `maxAttempts` (`5` default, configurable) `status=FAILED` retained (not deleted). Two publisher instances concurrent never claim same row (`SKIP LOCKED`). Publisher never runs inside business transactions; business latency is `FOR UPDATE` only.

**Why this priority**: Core of outbox. Wrong claim (no `SKIP LOCKED`, no lease) would duplicate or stall; wrong retry would lose events.

**Independent Test**: Unit test `OutboxPublisher.publishBatch` with mocked `DataSource`/`OutboxRepo` (`qb.setLock('pessimistic_write').setOnLocked('skip_locked')`) + mocked `ClientProxy` → assert `claim` sets `PROCESSING`, `emit` called with `payload.eventId == outbox.id`, then `SENT` on success, and `attempts=1 nextRetryAt≈NOW()+1s` on `throwError`, `FAILED` when `attempts>=max` (retain row). Simulate crash: insert `PROCESSING` with `processingStartedAt=NOW()-2*lease`, second publisher reclaims it. Concurrency: two publishers `publishBatch` concurrently with 5 pending events → each claims disjoint set (`skipLocked`).

**Acceptance Scenarios**:
1. **Given** 3 `PENDING` outbox rows, **When** `OutboxPublisher.poll()` claims batch `100`, **Then** `SELECT` uses `FOR UPDATE SKIP LOCKED`, 3 rows become `PROCESSING`, `client.emit` called 3× with `eventType` as pattern and body `{eventId, eventType, version, occurredAt, correlationId, payload}`, then 3 become `SENT` with `sentAt`.
2. **Given** RabbitMQ down for 2 attempts, **When** publisher retries, **Then** row shows `attempts 1→2 lastError ECONNREFUSED nextRetryAt = NOW()+1s then +2s`, and after `maxAttempts=5` `status FAILED` `attempts 5` retained (not deleted) for ops.
3. **Given** a `PROCESSING` row with `processingStartedAt` older than `lease (30s)` (worker crash), **When** next poll runs, **Then** row is reclaimed (`PROCESSING→PROCESSING` with fresh lease) and retried, proving lease recovery.

---

### User Story 4 — Consumers are at-least-once and idempotent; BullMQ remains separate from RabbitMQ retry (Priority: P2)

The existing `NotificationWorker` (RMQ `@EventPattern('order.*','reservation.expired')` or BullMQ bridge consumer `notifications`) receives the envelope published by `OutboxPublisher`. It logs `notification received <eventType> eventId=<eventId> correlationId=<id>` and (future) fans out to email/analytics/external stubs — **never** mutates `Inventory`/`Order`/`Reservation` business state. Because outbox guarantees at-least-once, the same `eventId` may arrive twice (publisher retries after RMQ accept but before `SENT` update). The consumer tolerates duplicates (V1: log-only is naturally idempotent; if operation required, guard via `if alreadyProcessed(eventId) return` or `Order.status` check). Retry layers are distinct: **PostgreSQL outbox → RabbitMQ** retries are durable (`attempts/nextRetryAt`); **RabbitMQ → BullMQ/consumer** retries are `BullModule` `attempts 3` inside the notification worker only if the worker itself throws, not conflated with publisher's retry.

**Why this priority**: P2 but documents the delivery semantics that Phase 11 previously glossed over (at-most-once vs at-least-once).

**Independent Test**: Call `NotificationWorker.handle({eventId, eventType:'order.completed', payload})` twice with same `eventId` → both log, no `Inventory.update` `0`, no `Order` mutation. For bridge variant `RabbitMQ → queue.add('notifications', envelope) → @Processor('notifications')`, verify RMQ handler acks even if `queue.add` fails? Actually bridge must `queue.add` **after** ack? Documented as `RMQ handler → BullMQ job` optional; V1 may go direct `@EventPattern` without BullMQ bridge — test both.

**Acceptance Scenarios**:
1. **Given** `order.completed` envelope `eventId=uuid` published once but delivered twice (publisher retry race), **When** `NotificationWorker` handles both, **Then** `Inventory.stock` unchanged both times, logs `duplicate eventId=<id> already processed` optional, no second `Order` write.
2. **Given** `NotificationWorker` throws `SMTP timeout` on `order.created`, **When** BullMQ `notifications` job processes it (`attempts 3` `backoff exponential`), **Then** `OutboxEvent` already `SENT` (publisher not retried), consumer retries independently; final consumer failure logged but publisher row not reset to `PENDING`.

---

### User Story 5 — Operators can verify outbox durability, retry health, and that no transaction holds RabbitMQ (Priority: P2)

An operator / CI runs `npm run test -- --runInBand`, `npm run build`, inspects Swagger/`GET /api`, queries `SELECT status, count(*) FROM outbox_event GROUP BY status`, and inspects logs. They see: checkout `201` latency not inflated by publisher (outbox insert inside transaction is cheap `INSERT`), publisher metrics/log `outbox publisher: claimed=10 sent=9 failed=1 nextRetryAt`, `Failed` events retained, cleanup strategy documented (retention `30d` purge), and proof that `client.emit` never occurs inside `dataSource.transaction` (grep `client.emit` inside `manager` callback 0). `AllExceptionsFilter` never turns a publisher failure into `500`.

**Independent Test**: Spy ordering `dataSource.transaction` → `OutboxEvent save` inside `manager` callback → `commit` → `publisher` elsewhere (separate tick). Assert `SELECT OutboxEvent WHERE status=FAILED` retained not deleted after `maxAttempts`. Query `EXPLAIN` shows index `(status, nextRetryAt, createdAt)` used.

**Acceptance Scenarios**:
1. **Given** `POST /order/checkout` succeeds, **When** timing measured, **Then** HTTP response < publisher interval, and `outbox_event` row created `PENDING` with `nextRetryAt <= NOW()`.
2. **Given** RabbitMQ down for entire publisher window, **When** operator queries `outbox_event`, **Then** rows remain `PENDING` with `attempts` increasing `nextRetryAt` exponential, not `SENT` or deleted.

---

### Edge Cases

- `RABBITMQ_URL` empty or `client` absent → business `POST /order/checkout` still `201`, outbox `PENDING` accumulates; publisher logs `RABBITMQ_URL not set, skipping publish` and leaves rows `PENDING` for later when URL set (no loss).
- Publisher crash after `PROCESSING` claim but before `client.emit` → lease (`processingStartedAt + lease 30s`) expires, next publisher reclaims via `PROCESSING AND processingStartedAt < NOW()-lease` and retries.
- Concurrent publishers (2 pods) claim overlapping batch → `FOR UPDATE SKIP LOCKED` guarantees disjoint sets; no duplicate `SENT`.
- `POST /order/checkout` validation `400` / `409` / `429` → no commit → no outbox row (spy `OutboxEvent save` 0).
- Expiration candidate already terminal (`RESERVED` no longer, or `Order` already `COMPLETED`) → transaction commits inventory no-op, zero new outbox rows (insert only on actual transition).
- Payload size / PII: outbox `payload JSONB` contains `version:1, correlationId, eventId, eventType, occurredAt` + `orderId,userId,total,items,reservationId` only; no `email`, `Authorization`, secrets; `Logger` logs `eventId correlationId` prefix only.
- Duplicate `order.created` for same checkout (idempotent retry `POST` with same `correlationId` but different `orderId`? V1 no dedup on `correlationId`; each `orderId` gets its own outbox row — `correlationId` is tracing, not dedup key).
- `OutboxEvent` `FAILED` after `maxAttempts` → retained `30d` (configurable `OUTBOX_RETENTION_DAYS`), not auto-deleted; ops can manually `requeue` by resetting `status=PENDING attempts=0 nextRetryAt=NOW()`.
- `FOR UPDATE SKIP LOCKED` not available on some DB? PostgreSQL 17 supports it — required; publisher uses `QueryBuilder.setLock('pessimistic_write').setOnLocked('skip_locked')`.
- `Payload` JSONB mutability: publisher never reconstructs from current DB; it publishes stored `payload` byte-equal, preserving `occurredAt` and `eventId`.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST persist **OutboxEvent** rows for every committed business transition in V1. Required set (`eventType` dot notation, PII-free, `version:1`):
  | Trigger (inside same transaction) | `eventType` | `aggregateType` | `payload` (persisted JSONB, PII-free) |
  |---------|---------|------|------------------------------|
  | `POST /order/checkout` `Order PENDING + Reservation RESERVED` + cart clear | `order.created` | `Order` | `{version:1, eventId: outbox.id, eventType:'order.created', occurredAt:ISO, correlationId, orderId, userId, total, currency, items:[{productId, inventoryId, quantity, unit_price}], reservationId, expiresAt, createdAt}` |
  | `POST /order/:id/complete` `PENDING→COMPLETED` `stock-=qty reserved-=qty` | `order.completed` | `Order` | `{version:1, eventId, eventType:'order.completed', occurredAt, correlationId, orderId, userId, previousStatus:'PENDING', newStatus:'COMPLETED', reservationId, items:[{inventoryId, quantity}], completedAt}` |
  | `PATCH /order/:id/cancel` or `POST /order/:id/cancel` or expiration auto-cancel `PENDING→CANCELLED|FAILED` `reserved-=qty` | `order.cancelled` | `Order` | `{version:1, eventId, eventType:'order.cancelled', occurredAt, correlationId, orderId, userId, previousStatus:'PENDING', newStatus:'CANCELLED'|'FAILED', reason:'user'|'failed'|'expired', reservationId}` |
  | `ReservationExpirationService.processExpiredBatch` per-candidate `RESERVED→EXPIRED` `reserved-=qty` (+ optional `Order PENDING→CANCELLED`) | `reservation.expired` (+ `order.cancelled` when auto-cancel) | `Reservation` (+ `Order` when cancelled) | `reservation.expired: {version:1, eventId, eventType:'reservation.expired', occurredAt, correlationId, reservationId, userId, orderId|null, items:[{inventoryId,quantity}], expiresAt, expiredAt}` |
  Future `auth.password_reset_requested`, `product.created`, `payment.succeeded` MAY reuse same `OutboxService` but MUST NOT be required for Phase 11 tests. Payloads MUST contain `version:1` and `correlationId` (from `X-Request-Id`/`X-Correlation-Id` or `crypto.randomUUID()` at controller) and `eventId == outbox.id`.

- **FR-002**: System MUST insert OutboxEvent **inside the same PostgreSQL transaction** as the business state change, via the transaction's `EntityManager`. Conceptual checkout:
  ```text
  BEGIN
  lock inventory FOR UPDATE (sortedIds)
  validate available = stock - reservedAmount >= qty → 409 else
  increase reservedAmount
  create Order PENDING + OrderItems (snapshot)
  create Reservation RESERVED (expiresAt now+15m)
  clear cart
  INSERT OutboxEvent {eventType:'order.created', aggregateType:'Order', aggregateId:orderId, payload:{version:1, eventId, eventType, occurredAt, correlationId, ...}, status:'PENDING', attempts:0, nextRetryAt:NOW()}
  COMMIT
  ```
  Do NOT insert outside transaction. Do NOT publish to RabbitMQ inside the transaction (no `client.emit` in `manager` callback). `OutboxService.createEvent(manager, {eventType, aggregateType, aggregateId, payload: {..., eventId: uuid, eventType, version:1, occurredAt, correlationId}, ...})` MUST be called with `manager` passed in.

- **FR-003**: System MUST refactor **Checkout** (`src/modules/order/order-checkout.service.ts:42`) to atomically include `OutboxEvent order.created` as above, preserving cart validation, deterministic lock ordering, `FOR UPDATE`, `available` check, `reservedAmount` bump, `total` calc, `createForCheckout` (no re-lock), `clearCartForCheckout` — only added step is `OutboxService.createEvent` before `return` inside `manager` block. Outbox row is created **only if** commit will happen (no insert on `400`/`409` throw).

- **FR-004**: System MUST refactor **Order Completion** (`src/modules/order/order-completion.service.ts:88`) to inside same `manager` transaction that locks `Order FOR UPDATE` → `assertOwner` → `validateOrderTransition` → `Reservation FOR UPDATE` → `sorted Inventories FOR UPDATE` → `stock-=qty reserved-=qty` → create `OutboxEvent order.completed` (`aggregateId=orderId`, `payload.eventType='order.completed'`) **before** saving `Order COMPLETED`/`Reservation COMPLETED`. Idempotent `COMPLETED→COMPLETED` shortcut MUST NOT create a duplicate outbox row (guard before insert). No `client.emit`.

- **FR-005**: System MUST refactor **Order Cancellation** (existing `PENDING→CANCELLED|FAILED` paths: explicit cancel endpoint if present, plus expiration auto-cancel). Creation MUST be centralized (e.g., `OrderService.cancel(manager, orderId, reason)` or extended `OrderCompletionService`) that inside one `manager` transaction locks `Order FOR UPDATE`, validates `PENDING→CANCELLED|FAILED`, decrements `reservedAmount` if still `RESERVED` (release) **or** `stock+=qty` if refund semantics? V1 `release reserved only` per `docs/plan.md` Phase 8 pre-decision (no `stock+=` after sale); insert `OutboxEvent order.cancelled {reason, correlationId}` atomically. Do not duplicate `order.cancelled` creation across call sites.

- **FR-006**: System MUST refactor **Reservation Expiration** (`src/modules/reservation/reservation-expiration.service.ts:199`) to create outbox events transactionally per candidate. For each `id`:
  ```text
  BEGIN
  lock Reservation FOR UPDATE
  verify still RESERVED AND expiresAt<=NOW() → else skip (no event)
  FOR UPDATE sorted Inventories
  reservedAmount -= quantity (per item)
  status=EXPIRED
  if orderId and Order PENDING: lock Order FOR UPDATE, Order PENDING→CANCELLED (auto-cancel)
  INSERT OutboxEvent reservation.expired (aggregateType Reservation)
  if order cancelled: INSERT OutboxEvent order.cancelled (reason:'expired', correlationId from expiration job or new UUID)
  COMMIT
  ```
  Only on actual transition. No `client.emit` inside. Poison/quarantine logic stays for DB errors, but outbox durability replaces lost-event fail-open.

- **FR-007**: System MUST separate **OutboxService** vs **OutboxPublisher** (remove direct `EventsService` RMQ publish from business logic):
  - `OutboxService` (`src/modules/outbox/outbox.service.ts`, `Injectable`, `Logger`): `createEvent(manager: EntityManager, {eventType, aggregateType, aggregateId, payload: {eventId?, eventType, version, occurredAt?, correlationId, ...}, status?:PENDING, attempts?:0, nextRetryAt?:Date}): Promise<OutboxEvent>` — generates `eventId=uuid` if not supplied, sets `payload.eventId`, `payload.occurredAt=NOW()`, `status=PENDING`, `attempts=0`, `nextRetryAt=NOW()`, saves via `manager.getRepository(OutboxEvent).save`.
  - `OutboxPublisher` (`src/modules/outbox/outbox.publisher.ts`, `Injectable`/`WorkerHost` `Logger`, `@Processor('outbox-publish')` or `setInterval` poll): `poll(limit?)`, `publishBatch(limit)` — claims, publishes, updates statuses. Business services MUST NOT inject `ClientProxy` directly; they inject `OutboxService`.

- **FR-008**: System MUST implement **OutboxPublisher claiming** safe for multiple instances:
  - Eligibility: `status = PENDING AND nextRetryAt <= NOW()` **OR** `(status = PROCESSING AND processingStartedAt < NOW() - lease)` (lease default `30s`, configurable `OUTBOX_PROCESSING_LEASE_MS`).
  - Claim: `SELECT ... WHERE (...) ORDER BY createdAt ASC, id ASC LIMIT batchSize FOR UPDATE SKIP LOCKED` → `UPDATE status=PROCESSING processingStartedAt=NOW()` per claimed row (single `UPDATE` with `RETURNING` or loop). Batch size default `100` (`OUTBOX_BATCH_SIZE`), max `200`.
  - Concurrency: two publishers with same `RABBITMQ_URL`/`DATABASE_URL` claim disjoint rows (verified `SKIP LOCKED`).

- **FR-009**: System MUST publish **persisted** payload to RabbitMQ (`NOTIFICATION_SERVICE` `Transport.RMQ` existing `RABBITMQ_URL`/`RABBITMQ_QUEUE=notification_queue` durable). Publisher:
  ```ts
  const envelope = {eventId: outbox.id, eventType: outbox.eventType, version: payload.version, occurredAt: payload.occurredAt, correlationId: payload.correlationId, payload }; // or payload itself already contains these
  const obs = client.emit(outbox.eventType, envelope);
  await lastValueFrom(obs); // or subscribe with promise wrapper
  ```
  Do NOT reconstruct from current DB state. Preserve `eventId, eventType, version, occurredAt, correlationId`. Use existing `ClientsModule` connection only (no second RMQ URL). If `RABBITMQ_URL` empty, publisher logs `RABBITMQ_URL not set, skipping publish` and leaves rows `PENDING` (no loss).

- **FR-010**: System MUST implement **exponential backoff retry** and terminal handling:
  - On success: `status=SENT sentAt=NOW() lastError=NULL processingStartedAt=NULL`.
  - On failure (`client.emit` throw or `Observable` error): `attempts++ lastError=msg substring(0,1000) nextRetryAt=NOW()+backoff(attempts)` where `backoff = baseDelay * 2^(attempts-1)` (base `1000ms` `OUTBOX_RETRY_BASE_MS`, cap `60s` or `60000ms` `OUTBOX_RETRY_MAX_MS`), `status=PENDING` (requeue) until `attempts >= maxAttempts` (`5` `OUTBOX_MAX_ATTEMPTS`) then `status=FAILED` **retained** (not deleted). `FAILED` useful for debugging/audit/manual replay.
  - Retention: `OUTBOX_RETENTION_DAYS=30` cleanup may `DELETE WHERE status IN (SENT,FAILED) AND sentAt/createdAt < NOW()-interval` via separate nightly `BullMQ` job or `DELETE` endpoint — not during publish.

- **FR-011**: System MUST document **at-least-once delivery** and require **consumer idempotency**:
  - Publisher crash sequence `publish → RMQ accept → crash before SENT update → re-publish → duplicate` is possible → consumer `NotificationWorker` MUST tolerate duplicate `eventId`. V1 worker is log-only → naturally idempotent; if future operation needs storage, document `SELECT processed_event WHERE eventId=:id` guard or `status` check (e.g., `if Order already COMPLETED skip`). `Inventory`/`Order`/`Reservation` MUST NOT be mutated inside worker.

- **FR-012**: System MUST keep **BullMQ vs RabbitMQ vs Outbox separation explicit**:
  - PostgreSQL Outbox: durable storage + publish retry + crash recovery (lease).
  - RabbitMQ: domain transport / fan-out (consumers: notification, email, analytics, external).
  - BullMQ: background app jobs, consumer-side retries, scheduled jobs (existing `reservation-expiration` BullMQ repeat `30s`/`EXPIRATION_CRON` stays; outbox publisher may also be BullMQ repeat `OUTBOX_POLL_INTERVAL_MS=1000` with `concurrency 1` + Redis `SET NX EX` leader lock optional but not required if `SKIP LOCKED` already serializes). Never claim RabbitMQ retries implicitly via BullMQ.

- **FR-013**: System MUST preserve **existing reservation expiration scheduling** (`src/modules/reservation/reservation-expiration.processor.ts:17` `@Processor reservation-expiration concurrency 1`) — it still scans `status=RESERVED AND expiresAt<=NOW()`, locks candidates, updates `reservedAmount`, auto-cancels order, **creates outbox events** commits; it does NOT publish to RMQ.

- **FR-014**: System MUST provide **indexes** for publisher query:
  - Composite `CREATE INDEX idx_outbox_status_next_retry_at_created ON outbox_event (status, nextRetryAt, createdAt)` or `status-nextRetryAt-createdAt` ordering matching `WHERE status IN ('PENDING','PROCESSING') AND nextRetryAt<=NOW() ORDER BY createdAt`.
  - Also index on `aggregateId` (`@Index`) for audit lookup, and `createdAt DESC`. Exact DDL chosen for query plan `EXPLAIN`.

- **FR-015**: System MUST provide **tests** proving outbox contract (per Testing Rules — unit mocked, integration real PG + mocked `ClientProxy`):
  - **Unit (mocked `DataSource`/`EntityManager`, mocked `ClientProxy` `{emit:()=>of(undefined)}`, `ConfigService`, `OutboxRepo`):**
    - Transactional consistency: `manager.save(OutboxEvent)` inside `dataSource.transaction` → commit creates both `Order` and `OutboxEvent`; throw → zero rows.
    - Checkout/complete/cancel each insert correct `eventType` + `payload.version:1` + `correlationId` + `eventId==id`.
    - Publisher successful: `PENDING→PROCESSING→SENT` with `client.emit` args `eventType` and persisted payload.
    - Publisher failed once: `attempts 1 lastError nextRetryAt = NOW()+1s` not `FAILED`.
    - Max retries: `attempts 5→ FAILED` retained not deleted.
    - Lease reclaim: `PROCESSING` with `processingStartedAt=NOW()-60s` reclaimed by next poll.
    - Concurrent claim: two publishers `SKIP LOCKED` disjoint.
    - Duplicate delivery: `NotificationWorker.handle` twice same `eventId` → no `Inventory.update`.
    - RMQ absent: `RABBITMQ_URL` empty → publisher skip, row stays `PENDING`.
  - **Integration (real PG via docker-compose, real `OutboxEvent` table, mocked `ClientProxy`):**
    - Real checkout with `manager` inserts `Inventory reservedAmount` and `OutboxEvent PENDING` in same `SELECT FOR UPDATE` commit.
    - Expiration batch with 2 `RESERVED` (one with order) → `reservation.expired x2` + `order.cancelled x1` counts.
    - Publisher `poll(100)` with real `FOR UPDATE SKIP LOCKED` batch claims 10 rows, publishes mocked `emit` 10×, marks all `SENT`.
  - **E2E (supertest `POST /order/checkout` + `POST /order/:id/complete`):**
    - `register → login → cart → POST /order/checkout → 201` → poll `GET /outbox?aggregateId=orderId` shows `PENDING` then after publisher `SENT`, RabbitMQ mock captured `eventType order.created`.
    - RabbitMQ down simulation (mock `emit` throw) → still `201`, outbox `PENDING` retry.

- **FR-016**: System MUST remain **thin & observable**: `OutboxService` + `OutboxPublisher` each `Injectable` with class-level `/** This service is responsible for ... */` + method `/** @param @returns @throws */` per `AGENTS.md` §3; every status change logs `Logger.log outbox claim id=<id> eventType=<t> attempts=<n>` / `Logger.warn outbox publish failed id=<id>: <msg> nextRetryAt=<iso>`; no `console.log`.

### Key Entities

- **OutboxEvent**: `PostgreSQL` table `outbox_event` (source of truth for delivery, not a migration afterthought). Fields:
  ```text
  id                uuid PK @PrimaryGeneratedColumn('uuid') // eventId
  eventType         varchar — 'order.created' | 'order.completed' | 'order.cancelled' | 'reservation.expired' (@Index)
  aggregateType     varchar — 'Order' | 'Reservation' (indexed)
  aggregateId       uuid FK-ish (no FK constraint to allow `DELETE CASCADE` on business rows? Keep @Index, no hard FK to keep eventual cleanup simple; document decision)
  payload           jsonb — {version:1, eventId: id, eventType, occurredAt:ISO, correlationId, ...business fields} PII-minimal
  status            enum OutboxStatus {PENDING, PROCESSING, SENT, FAILED} default PENDING @Index (composite)
  attempts          int default 0 CHECK >=0
  nextRetryAt       timestamptz NOT NULL default NOW() @Index
  lastError         varchar nullable (1000 chars)
  processingStartedAt timestamptz nullable — set when claimed to PROCESSING for lease
  createdAt         timestamptz @CreateDateColumn
  sentAt            timestamptz nullable — set when SENT
  ```
  Indexes: `(status, nextRetryAt, createdAt)` composite, `eventType`, `aggregateId`, `createdAt DESC`. Constraints: `CHECK attempts>=0`, `CHECK payload->>'version' IS NOT NULL`. `payload` is `jsonb` (not `json`) for index ops.

- **OutboxStatus**: `enum {PENDING, PROCESSING, SENT, FAILED}` — `PENDING→PROCESSING→SENT` success; `PROCESSING→PENDING` retry (until `maxAttempts` → `FAILED`). `FAILED` is terminal (manual requeue `UPDATE status=PENDING attempts=0 nextRetryAt=NOW() WHERE id=:id`).

- **OutboxService**: `Injectable` at `src/modules/outbox/outbox.service.ts` (new module `OutboxModule` `TypeOrmModule.forFeature([OutboxEvent])`). Methods: `createEvent(manager, {eventType, aggregateType, aggregateId, payload, correlationId?}): Promise<OutboxEvent>` — generates `id`, sets `payload.eventId=id`, `payload.occurredAt=NOW()`, `status=PENDING`, `attempts=0`, `nextRetryAt=NOW()`. Exported for `OrderModule`, `ReservationModule`.

- **OutboxPublisher**: `Injectable` `WorkerHost` at `src/modules/outbox/outbox.publisher.ts` (+ `OutboxProcessor` `@Processor('outbox-publish')` if BullMQ-scheduled, or plain `Interval` `setInterval` `1000ms` with Redis `SET NX EX` leader lock). Config: `OUTBOX_BATCH_SIZE=100`, `OUTBOX_POLL_INTERVAL_MS=1000`, `OUTBOX_PROCESSING_LEASE_MS=30000`, `OUTBOX_MAX_ATTEMPTS=5`, `OUTBOX_RETRY_BASE_MS=1000`, `OUTBOX_RETRY_MAX_MS=60000`, `OUTBOX_RETENTION_DAYS=30`. Uses `DataSource` + `ClientProxy`. Method `publishBatch(batchSize?)`.

- **RabbitMQ `notification_queue`**: Unchanged durable `NOTIFICATION_SERVICE` `Transport.RMQ` `RABBITMQ_QUEUE=notification_queue`. Envelope is `payload` already persisted (no reconstruction).

- **NotificationWorker / EventsConsumer**: Unchanged RMQ `@EventPattern('order.*','reservation.expired')` at `src/modules/notifications/notifications.worker.ts`, `concurrency 5`, `BullModule` consumer retry `attempts 3` **separate** from publisher retry; now at-least-once tolerant.

- **Order/Reservation/Inventory**: Existing, never mutated by publisher/worker beyond the owning service's transaction.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001 (Transactional atomicity)**: With real PostgreSQL, `POST /order/checkout` with cart `qty 2` `available 10` commits a single `DataSource.transaction` that `SELECT Order WHERE id=:id` exists **and** `SELECT OutboxEvent WHERE aggregateId=:id AND eventType='order.created'` exists `status PENDING` `payload.eventId==id` `payload.version==1` `payload.correlationId` non-null; when transaction is forced to `409` (insufficient), zero `Order` and zero `OutboxEvent` rows exist. Verified by integration `DataSource.transaction` spy + `outbox_event` count.

- **SC-002 (Broker outage durability)**: With `ClientProxy.emit` mocked to throw `ECONNREFUSED`, `POST /order/checkout` still `201` and `OutboxEvent` remains `PENDING` `attempts 1→` `nextRetryAt > NOW()` (not `SENT`, not deleted); after `emit` restored, next `OutboxPublisher.poll()` marks `SENT` `sentAt` and RabbitMQ mock captures `eventType order.created` with `eventId` matching outbox `id`. No event lost.

- **SC-003 (Completion & expiration atomicity)**: `POST /order/:id/complete` `PENDING→COMPLETED` inserts `order.completed` `PENDING` in same commit; publisher eventually `SENT`. Expiration batch with 2 `RESERVED` (one with `Order PENDING`) inserts `reservation.expired x2` + `order.cancelled x1` **atomically** with the `RESERVED→EXPIRED` / `PENDING→CANCELLED` state changes; second tick with same ids inserts zero new rows.

- **SC-004 (Claim & concurrency)**: `OutboxPublisher.publishBatch(100)` with 10 `PENDING` claims via `SELECT ... FOR UPDATE SKIP LOCKED ORDER BY createdAt ASC LIMIT 100` and sets `PROCESSING` with `processingStartedAt`; two publishers running concurrently claim disjoint sets (spy `qb.setLock('pessimistic_write').setOnLocked('skip_locked')` called, `SELECT count()` disjoint).

- **SC-005 (Retry & lease)**: Failed publish increments `attempts` and sets `nextRetryAt = NOW()+base*2^(attempts-1)` (1s,2s,4s,8s,16s up to cap) and keeps `status PENDING` until `attempts>=5` then `status FAILED` retained (not deleted) with `lastError`. A `PROCESSING` row with `processingStartedAt < NOW()-30s` is reclaimable by next poll (lease expiry).

- **SC-006 (At-least-once + idempotency)**: Duplicate delivery of same `eventId` (publisher retry race) to `NotificationWorker.handle` twice leaves `Inventory.stock/reservedAmount` unchanged both times (`Inventory.update` spy `0`); worker logs `duplicate eventId=<id> already processed` optional, no `Order`/`Reservation` mutation.

- **SC-007 (No RMQ inside transaction)**: Grep `client.emit` inside `dataSource.transaction(async manager =>` returns 0; `AllExceptionsFilter` never sees publisher throw as `500`; `RateLimitGuard 429` → zero `OutboxEvent` rows and zero publisher work; `ValidationPipe 400` → zero rows.

- **SC-008 (Separation of retries & cleanup)**: `NotificationWorker` consumer-side `attempts 3` (BullMQ `notifications` if used) is independent from publisher `maxAttempts 5`; `FAILED` outbox rows remain queryable `SELECT WHERE status=FAILED` for `30` days, not auto-purged; `EXPLAIN` shows composite index `status-nextRetryAt-createdAt` used for publisher query; `npm run build` + `npm run test -- --runInBand` (≥24 suites including 8+ outbox unit/integration) + `npm run test:e2e` pass with `synchronize:false`.

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; `outbox_event` is the durable store for at-least-once; RabbitMQ/BullMQ/Redis are not sources for `Order`/`Reservation`/`Inventory` (constitution I/III). A `FLUSHDB` purges Redis/BullMQ but never `outbox_event`; RMQ purge is recoverable via publisher retry.
- **A2**: Phases 0–10 entities unchanged (`Product` no stock, `Inventory` `CHECK`, `Cart` eager, `Reservation` composite index, `Order PENDING|COMPLETED|CANCELLED|FAILED`, `synchronize:false`, migrations `1755800000000–1755900000002` intact). New migration `17559xxxxxx-CreateOutboxEvent` adds table + indexes; prior migrations never edited.
- **A3**: `AppModule` infra re-used: `TypeOrmModule` global, `BullModule.forRootAsync` shared `REDIS_URL`, `ClientsModule NOTIFICATION_SERVICE` `RABBITMQ_QUEUE=notification_queue` durable, `CacheModule` unchanged; publisher re-uses single `ClientProxy` and single `DataSource`, no second RMQ/ioredis connection.
- **A4**: Checkout remains cart-only (`POST /order/checkout {}` empty `400` if `items[]` sent, `forbidNonWhitelisted`), deterministic `sortedIds` lock, `available` check — only addition is `OutboxService.createEvent`.
- **A5**: `RateLimitGuard` outermost + `ValidationPipe` still block before transaction → zero outbox rows on `429`/`400`.
- **A6**: Publisher concurrency `5` (worker) vs batch `100` vs poll `1s` vs lease `30s` vs base `1s` max `60s` vs maxAttempts `5` vs retention `30d` are defaults, all via `ConfigService` (`OUTBOX_*` env) without code change.
- **A7**: Logging PII-safe: `eventId + correlationId + eventType + aggregateId` only; `payload` not logged verbatim; `lastError` truncated `1000` chars no secrets.
- **A8**: Testing: mocked `ClientProxy` for unit, real PG + mocked RMQ for integration; `--runInBand --forceExit` `transformIgnorePatterns` for `@nestjs/bullmq` ESM.
- **A9**: `correlationId` tracing kept: controller extracts `X-Request-Id`/`X-Correlation-Id` or `randomUUID()` and passes to `OutboxService.createEvent`; `payload.correlationId` stored so publisher can preserve it.
- **A10**: V1 workers remain log-only (`NoopEmailProvider` future Phase 18); idempotency is trivial duplicate tolerance, not storage-backed dedup (unless future `processed_event` table).

---

## 6. Dependencies

- Phases 0–10 (`Inventory`, `Reservation FOR UPDATE`, `Order` checkout-only, `Cart` eager, `Auth tokenVersion`, `Products` GraphQL, `synchronize:false`).
- `TypeOrmModule` + `DataSource` (`EntityManager` inside `dataSource.transaction`) + new `OutboxEvent` entity + `OutboxModule` (`exports: [OutboxService]`).
- `AppModule` infra: `ConfigModule` (`RABBITMQ_URL`, `RABBITMQ_QUEUE`, `REDIS_URL`, plus new `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_PROCESSING_LEASE_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_MAX_MS`, `OUTBOX_RETENTION_DAYS`).
- Global `ValidationPipe`, `AllExceptionsFilter`, `Logger`, `RateLimitGuard` outermost, `JwtGuard`/`RolesGuard`.
- `OrderCheckoutService`, `OrderCompletionService` (+ `OrderCancellationService` if new), `ReservationExpirationService`/`Processor` (`@Processor reservation-expiration` still `30s`).
- `ClientsModule NOTIFICATION_SERVICE` (RMQ) + optional `BullModule.registerQueue({name:'outbox-publish'})` for publisher scheduling.

---

## 7. Out of Scope (this phase)

- Outbox **cleanup** beyond retention `DELETE WHERE SENT/FAILED AND sentAt/createdAt < NOW()-30d` (scheduled job deferred to Phase 12 ops; V1 retains at least description, not necessarily timer).
- Persistent event store / CQRS replay (`OrderEvent` history) — `outbox_event` is transient delivery buffer, not event sourcing.
- Email (Phase 18) / Payment (Phase 19) providers, `EmailVerificationToken`, Stripe — worker only logs; Phase 18 will reuse `OutboxService` envelope.
- Business-state mutation inside `NotificationWorker` or publisher (publisher never touches `Inventory`).
- Consumer dedup storage `processed_event` beyond trivial log-idempotency (Phase 12 if needed).
- RabbitMQ exchange / routing-key redesign, topic vs direct (single `notification_queue` durable suffices).
- Changing business semantics of checkout/complete/cancel/expiration (only additive `INSERT outbox_event`).

---

## 8. Clarifications

### Session 2026-09-23 (Phase 11 kickoff + Outbox refactor)

- Q: Which events in V1 and what payloads? → **A: `order.created` (checkout `Order PENDING+Reservation`), `order.completed` (PENDING→COMPLETED), `order.cancelled` (PENDING→CANCELLED|FAILED, reason 'user'|'failed'|'expired'), `reservation.expired` (+ `order.cancelled` when auto-cancel) with `{version:1, eventId==outbox.id, eventType, occurredAt, correlationId, orderId,userId,total,items,reservationId,...}` PII-free, `correlationId` from header or UUID.**
- Q: Where does division RabbitMQ vs BullMQ fall? → **A: RabbitMQ for domain fan-out, BullMQ for scheduled/retry (`reservation-expiration-tick` + optional `outbox-publish` repeat). Clarified via outbox: PostgreSQL outbox = durable buffer + publisher retry, RabbitMQ = transport, BullMQ = background jobs — not conflated.**
- Q: Publish inside transaction vs after commit? → **A: Superseded by outbox refactor 2026-09-23: NEVER publish inside business transaction. Instead `INSERT outbox_event` inside same transaction via `EntityManager`; dedicated `OutboxPublisher` publishes async after commit. Prior `EventsService.publishAfterCommit` is removed; `OutboxService` is the only business-touching writer.**
- Q: What happens when broker/queue is down? → **A: Superseded: fail-open no longer loses events. Business `201` still, outbox row stays `PENDING` with `attempts++ nextRetryAt` exponential; publisher retries until `SENT` or `FAILED` (retained). Previous "log and drop" removed.**
- Q: Must workers ever mutate inventory/order inside consumer? → **A: Never — log/notify only, idempotent on duplicate `eventId` (at-least-once).**
- Q: For order domain events, which transport(s) should EventsService use? → **A: Superseded: direct `EventsService` removed. Publisher is `OutboxPublisher` → RabbitMQ only for domain events; BullMQ only for scheduling (`reservation-expiration-tick`, `outbox-publish` interval) and consumer retries — no dual publish per event.**
- Q: Event payloads are PII-free. How should email workers obtain recipient address? → **A: Lookup in worker by `userId` via `UsersService`/`UserRepository`; payload carries only `userId`.**
- Q: When a notification worker job fails 3 times (poison), how should it be handled? → **A: Publisher poison (`attempts>=maxAttempts` → `FAILED` retained) separate from consumer `notifications` retry (`attempts 3` consumer-side). Publisher `FAILED` not deleted.**
- Q: Should event payloads include an explicit schema version? → **A: Yes, `version:1` (and `payload.version`) for forward compatibility.**
- Q: Should events carry a correlationId/traceId? → **A: Yes, `correlationId` from `X-Request-Id`/`X-Correlation-Id` or `randomUUID()` stored in payload for E2E tracing.**
- Q: Refactor to Transactional Outbox — what is the new architecture? → **A: Business transaction + OutboxEvent INSERT atomic → `COMMIT` → `OutboxPublisher` (`FOR UPDATE SKIP LOCKED` batch 100, lease 30s, `PENDING→PROCESSING→SENT/FAILED`) publishes persisted payload to RabbitMQ `notification_queue` with exponential backoff (`+1s,+2s,+4s,+8s,+16s`, base/max configurable, max 5) at-least-once; `FAILED` retained; consumers idempotent; no `client.emit` inside business transaction; no event loss on RMQ down.**

---

## 9. Acceptance Scenarios (for planning)

1. Checkout atomic outbox: `POST /order/checkout 201` → single commit creates `Order PENDING` + `OutboxEvent order.created PENDING {version:1, eventId, correlationId}`; `409` rollback creates neither.
2. Broker down durability: `emit` throw → `201` + `OutboxEvent PENDING attempts=1 nextRetryAt≈NOW()+1s` retained; later poll → `SENT`.
3. Completion atomic: `POST /order/:id/complete 200 COMPLETED` → same transaction inserts `order.completed PENDING`; idempotent `COMPLETED→COMPLETED` inserts none.
4. Expiration atomic: `processExpiredBatch` `RESERVED→EXPIRED` + `PENDING→CANCELLED` → `reservation.expired PENDING` + `order.cancelled PENDING` atomically; no event on no-op transition.
5. `429`/`400` guard: `RateLimitGuard 429` / `ValidationPipe 400` → zero outbox rows, zero publisher claim.
6. Publisher claim/batching/lease: `FOR UPDATE SKIP LOCKED` batch 100, `PENDING→PROCESSING→SENT`, `attempts` exponential, `FAILED` retained, `PROCESSING` lease reclaim after `30s`.
7. At-least-once idempotency: duplicate `eventId` delivery → `NotificationWorker` no `Inventory` mutation, logs duplicate.
8. No RMQ inside transaction: `grep client.emit` inside `dataSource.transaction` 0 hits; `AllExceptionsFilter` not involved.

