# Feature Specification: Reliability / Idempotency — Phase 12

**Feature Branch**: `012-reliability-idempotency`  
**Created**: 2026-09-23  
**Status**: Draft  
**Input**: User description: "phase 12 in the plan"  
**Source**: `docs/plan.md` Phase 12 (§12), constitution I/IV/V (PostgreSQL authoritative, concurrency at DB, module boundaries), existing `src/modules/reservation/reservation.service.ts` + `reservation-expiration.service.ts` (`FOR UPDATE` `RESERVED→EXPIRED` + BullMQ repeat 30s lease 30s), `src/modules/order/order-completion.service.ts` (`PENDING→COMPLETED` `stock-=qty reserved-=qty` idempotent `COMPLETED→COMPLETED`), `src/modules/outbox/outbox.publisher.ts` (Phase 11 `FOR UPDATE SKIP LOCKED` batch 100 `PENDING→PROCESSING→SENT/FAILED` exponential `1s*2^n` max 5), `src/modules/inventory/inventory.service.ts` (`available = stock - reservedAmount` `CHECK`s)

---

## 1. Overview

Phases 1–11 built a transactionally correct, at-least-once async pipeline:

- `Inventory` (`stock`, `reservedAmount`, `available` derived, `CHECK` `reservedAmount<=stock`)
- `Reservation` `RESERVED→COMPLETED|EXPIRED|CANCELLED` with `FOR UPDATE` sorted inventories
- `Order` checkout-only `POST /order/checkout {}` → `Order PENDING + Reservation RESERVED` atomic
- `OrderCompletion` `POST /order/:id/complete` → `Order PENDING→COMPLETED + Reservation RESERVED→COMPLETED + stock-=qty reserved-=qty` transactional, idempotent `COMPLETED→COMPLETED` 200
- Expiration worker `reservation-expiration` BullMQ `30s` with Redis tick lock + `FOR UPDATE` single-winner
- Outbox Phase 11 `OutboxEvent` `PENDING→PROCESSING→SENT/FAILED` `FOR UPDATE SKIP LOCKED` batch 100 lease 30s backoff `1s*2^n` max 5 retained, at-least-once

**Gap**: Phase 11 made *delivery* durable, but **Phase 12 makes *execution* idempotent**. Today the invariants hold for the happy path and for single-retry races that happen to hit the `status != RESERVED` guard. Going forward every retryable path (worker reprocessing, client retry after `201` timeout, RabbitMQ redelivery, BullMQ retry) must be **provably idempotent**: *re-executing the same logical operation twice must not double-subtract inventory, double-complete an order, or double-send a notification.*

This phase **does not add new business state** — it **hardens all existing transitions** and documents the retry/failure contract:

```text
Retryable?  ──► idempotent guard (status check / eventId / jobId)
   │
   ├── Reservation expiration reprocess same id ──► second attempt: already EXPIRED → do nothing
   ├── Notification job duplicate delivery        ──► second delivery eventId seen → skip send
   ├── Order completion duplicate POST            ──► second complete: already COMPLETED → 200 no inventory delta
   ├── Inventory release duplicate (cancel vs expire race) ──► loser sees not RESERVED → no reserved-=qty
   └── Outbox publish retry (Phase 11)            ──► same eventId re-published → consumer tolerates duplicate
Non-retryable (permanent 4xx) ──► no retry, no idempotency storage needed
```

**Critical invariant (P0 — unchanged, now enforced end-to-end):** *No operation may subtract `stock` or `reservedAmount`, or change `Order.status`/`Reservation.status`, more than once for the same logical cause.* `available = stock - reservedAmount` is never double-applied.

**V1 scope**: identify retryable vs terminal, harden expiration + notification + completion + inventory-release idempotency, define retry (attempts/backoff/cap/poison) and failure handling (log, `FAILED` retained, no rollback of committed transaction). No new payment/email provider — reuse Phase 11 outbox envelope `version:1 + correlationId`.

### Goal

Repeated processing of the same reservation, order, or notification — whether from worker crash-reclaim, client retry, or broker redelivery — cannot corrupt inventory, and every retryable failure has a bounded, observable retry policy. — `docs/plan.md` Phase 12 Exit Criteria: *reprocessing the same reservation/order/notification twice leaves state identical to processing once.*

---

## 2. User Scenarios & Testing

### User Story 1 — Reservation expiration is idempotent — second attempt does not double-release inventory (Priority: P1)

Two expiration actors (BullMQ worker vs manual `PATCH /reservations/:id/expire` admin, or two workers after lease expiry) attempt to expire the **same** `Reservation RESERVED` with `qty 2` (`Inventory stock 10 reserved 2 available 8`). The first transaction locks `Reservation FOR UPDATE`, verifies `status==RESERVED`, locks sorted `Inventories FOR UPDATE`, does `reservedAmount 2→0`, `status RESERVED→EXPIRED`, commits. The second attempt locks same `Reservation FOR UPDATE` after commit, sees `status EXPIRED`, **does not** do `reservedAmount -= qty` again — `reservedAmount` stays `0` `available 10`, second call returns `200 already EXPIRED` (standardized Q2) **no inventory delta**. Same holds for expiration vs concurrent `POST /order/:id/complete` (complete wins → expiration loser sees `COMPLETED` → `409` conflicting transition, no `reserved-=qty`) and `POST /reservations/:id/cancel` vs expire (same-transition second `cancel`→`200`, cross-transition `CANCELLED→EXPIRED`→`409`).

**Why this priority**: Load-bearing inventory correctness. The doc example (`RESERVED→EXPIRED` `reserved-=qty` then second attempt must not subtract again) if broken silently leaks inventory (`reservedAmount` negative or `available` inflated → oversell window).

**Independent Test**: Integration real PG: seed `Inventory stock 10 reserved 2`, `Reservation RESERVED qty 2`. Run `ReservationTransitionBuilder` / `ReservationService.expire(manager, id)` **twice** sequentially inside `dataSource.transaction` (or via `POST /reservations/:id/expire` twice `supertest`). Assert after first: `Reservation EXPIRED`, `Inventory reserved 0 stock 10 available 10`. After second: `Reservation` still `EXPIRED`, `Inventory` unchanged `reserved 0 stock 10`, `attempts` not incremented, response `200` idempotent (Q2) `Inventory.update` spy `0`. Concurrency: two promises `Promise.all([expire(id), expire(id)])` with `FOR UPDATE` → one `200` first `EXPIRED`, second `200` idempotent, `reservedAmount` decremented exactly once.

**Acceptance Scenarios**:
1. **Given** `Reservation RESERVED qty 2 reservedAmount 2 stock 10`, **When** `expire` committed then **When** same `expire` re-executed, **Then** first `reserved 2→0`, second `reserved` stays `0` `stock 10`, no `reservedAmount <0`, `CHECK` not violated, `status EXPIRED` both times.
2. **Given** `Reservation RESERVED` with concurrent `complete` and `expire` (`FOR UPDATE Reservation` then sorted `Inventories`), **When** both race via `Promise.all`, **Then** exactly one succeeds (`COMPLETED stock 8 reserved 0` **or** `EXPIRED reserved 0`), loser sees `status != RESERVED` → `409` or `200 already terminal` and performs zero inventory mutation.

---

### User Story 2 — Notification jobs are idempotent — duplicate delivery does not duplicate side effects (Priority: P1)

The outbox publisher (Phase 11) guarantees at-least-once: `order.created` `eventId=uuid` may be published, RMQ accepts, publisher crashes before `SENT` → re-published after lease → RMQ delivers **twice**. The `NotificationWorker` (`@EventPattern('order.created','reservation.expired')` or BullMQ `notifications` queue) receives same `eventId` twice. The first delivery fans out to `EmailProvider.send` (noop in dev/test) and inserts `NotificationLog` (if audit enabled) and `ACK`s; the second delivery with same `eventId` is recognized as duplicate and **skips** `EmailProvider.send` and does **not** insert a second `NotificationLog`. The same holds for BullMQ `notification.sendBulk` bulk jobs retried after transient `SMTP 5xx` — second attempt skips already-sent `<template>:<campaignId>:<userId>`.

**Why this priority**: Phase 11 made duplicate delivery *possible*; Phase 12 makes it *harmless*. Without this, sales campaigns would double-email users.

**Independent Test**: Unit mock `EmailProvider` + `NotificationWorker.handle({eventId, eventType:'order.created', payload:{userId, orderId}})`: call `handle` twice with same `eventId` → first `EmailProvider.send` `1`, `NotificationLog INSERT` `1`; second `send` `0` (guard `if alreadyProcessed(eventId) return`), `INSERT` `0`. Integration real Redis: `SET NX notification:send:order.created:<orderId>:<userId> EX 24h` first `1` second `0` → skip. Assert `Inventory/Order` spies `0` both times.

**Acceptance Scenarios**:
1. **Given** `OutboxEvent SENT eventId=abc order.created` already consumed (processed set contains `abc`), **When** same envelope redelivered, **Then** `NotificationWorker` logs `duplicate eventId=abc skipped` `200` ack, `EmailProvider.send` not called again, `NotificationLog` count unchanged.
2. **Given** bulk `sales campaignId=c1` with 10 users `marketingOptIn true`, **When** `sendBulk` job retries after 5 sent, **Then** second run `SET NX notification:send:sales:c1:<userId>` returns `0` for first 5 (skip) and `1` for remaining 5 (send `5` only), total `Log` rows `10` not `15`.

---

### User Story 3 — Duplicate order completion does not duplicate inventory deduction (Priority: P1)

A client calls `POST /order/:id/complete` (or `PATCH` alias) `PENDING→COMPLETED` (`stock 10→8 reserved 2→0` qty 2) and retries because the first `200` timed out. The second request arrives with same `orderId`. The service locks `Order FOR UPDATE`, sees `status COMPLETED`, **does not** execute `stock-=qty reserved-=qty` again, returns `200 {status:COMPLETED}` (idempotent success per Phase 7 Q4). The same guard holds for `POST /payments/webhook`-style future callers that reuse `OrderCompletionService` — the inventory helper checks `Order.status` before mutating.

**Why this priority**: Direct inventory corruption. `stock-=2` twice would be `stock 6` instead of `8` → phantom shortage.

**Independent Test**: Real PG: `Order PENDING` + `Reservation RESERVED qty 2` `Inventory stock 10 reserved 2`. Call `OrderCompletionService.complete(manager, userId, orderId)` twice sequentially (`await complete` then `await complete`). Assert after first: `Order COMPLETED`, `Inventory stock 8 reserved 0`. After second: `status COMPLETED`, `Inventory stock 8 reserved 0` unchanged, second call did not `UPDATE Inventory`, returned `200`. Concurrency: `Promise.all([complete(orderId), complete(orderId)])` → one `200` with mutation, one `200` idempotent, `stock` decremented exactly once.

**Acceptance Scenarios**:
1. **Given** `Order PENDING reserved 2 stock 10`, **When** `POST /order/1/complete 200` then **When** same `POST /order/1/complete` again, **Then** second `200` `COMPLETED`, `SELECT Inventory stock 8 reserved 0` unchanged, no `CHECK` violation, `OrderCompletionService` second transaction performed zero `UPDATE inventory SET stock = stock - :qty`.
2. **Given** concurrent `complete` vs `complete` (`FOR UPDATE Order` then `Reservation` then sorted `Inventories`), **When** both race, **Then** `stock` decremented exactly once, both callers observe `COMPLETED`, no `23514 CHECK`.

---

### User Story 4 — Duplicate inventory release (cancel vs expire vs cancel) does not double-release `reservedAmount` (Priority: P1)

A `Reservation RESERVED qty 2 reserved 2` is cancelled (`RESERVED→CANCELLED reserved 2→0 stock 10 unchanged`) and then expiration fires for same id, or two `cancel` calls race, or `OrderCancellationService` explicit cancel vs expiration auto-cancel race. Only the first transition performs `reservedAmount -= qty`; the second sees `status CANCELLED|EXPIRED|COMPLETED` and performs zero inventory mutation. `reservedAmount` never goes negative, `stock` unchanged on cancel/expire paths, `available` stays `10`.

**Why this priority**: `reservedAmount` double-release → `reservedAmount -2` → next checkout over-reserves (`available` inflated → oversell).

**Independent Test**: Real PG: `Reservation RESERVED qty 2 reserved 2`. `cancel(id)` → `CANCELLED reserved 0`. Second `cancel(id)` → stays `CANCELLED reserved 0`. Assert `reservedAmount` `0` both after, `UPDATE Inventory` second `0` calls. Race: `Promise.all([cancel(id), expire(id)])` → one `200` with `reserved-=qty`, other `409`/`200` with `0` mutation, final `reserved 0`.

**Acceptance Scenarios**:
1. **Given** `RESERVED qty 2 reserved 2`, **When** `PATCH /reservations/:id/cancel 200 CANCELLED reserved 0` then **When** `PATCH /reservations/:id/expire` (or second `cancel`), **Then** second leaves `reserved 0 stock 10` unchanged, response `409` or idempotent `200` but `Inventory` `UPDATE` `0`.
2. **Given** concurrent `cancel` vs `expire` both `FOR UPDATE Reservation → FOR UPDATE sorted Inventories`, **When** both commit, **Then** `reserved` decremented exactly once, final `status` is either `CANCELLED` or `EXPIRED` (first winner), not both, `CHECK reservedAmount>=0` holds.

---

### User Story 5 — Every retryable operation has a bounded retry policy; permanent failures do not retry and are retained for ops (Priority: P2)

An operator reads the documented retry matrix. Transient failures (`ECONNREFUSED`, `ETIMEDOUT`, `429`, `503`, `Stripe 5xx` future) are retried with **exponential backoff** `baseDelay * 2^(attempts-1)` capped, up to `maxAttempts`, then marked `FAILED` **retained** (not deleted) for manual replay. Permanent failures (`400` validation, `404` not found, `409` already terminal, `23514 CHECK`, `401` bad token) are **not** retried — they are either `200` idempotent or `400` ack without retry. Outbox publisher already implements this (Phase 11 `1s·2^n` max 5 cap 60s lease 30s); Phase 12 makes the same policy apply to `ReservationExpirationProcessor` (BullMQ `attempts 3` + poison quarantine `24h` already) and `NotificationWorker` (BullMQ `attempts 3` `backoff exponential` per job, max `5` for outbox), and documents that business `checkout/complete/cancel` are **not** retried server-side (client may retry → idempotent guard).

**Why this priority**: Unbounded retry would hot-loop DB; retrying `400` would hide bug; losing `FAILED` rows would hide outages.

**Independent Test**: Unit mocked `OutboxPublisher`/`ReservationExpirationService`: inject `ConfigService` `OUTBOX_MAX_ATTEMPTS=5 OUTBOX_RETRY_BASE_MS=1000`. Simulate `client.emit` `throw 503` `5` times → attempts `1..5` `nextRetryAt +1s +2s +4s +8s +16s` then `FAILED` retained. Simulate `throw 400` classified as non-retryable? V1 Phase 11 retries all RMQ failures equally (RMQ `ECONNREFUSED` is transient) — document that HTTP `400` inside `NotificationWorker` does not trigger publisher retry (publisher already `SENT`). For `ReservationExpirationProcessor` poison: `processExpiredBatch` throw `23514` `3` times → `poisonCount 3` → `24h quarantine` `SET expiration:poison:quarantine EX 86400`, batch skipped.

**Acceptance Scenarios**:
1. **Given** `OutboxEvent PENDING` with `client.emit` transient `ECONNREFUSED`, **When** publisher retries, **Then** `attempts 1 nextRetryAt NOW()+1s`, `2 → +2s`, `3 → +4s`, `4 → +8s`, `5 → FAILED` retained not deleted, queryable `SELECT WHERE status=FAILED`.
2. **Given** `ReservationExpirationService` `FOR UPDATE` succeeds but `UPDATE Inventory` throws `23514` (e.g., `reservedAmount<0`), **When** retried `3` times, **Then** poison counter `3` → quarantine `24h`, next `30s` tick skips processing and logs `quarantined <n>s`, not hot-loop.

---

### User Story 6 — Operator can verify idempotency and retry health without code inspection (Priority: P2)

An operator/CI can assert: `POST /reservations/:id/expire` twice → `SELECT reservedAmount` unchanged; duplicate `NotificationWorker` eventId → `EmailProvider.send` called once; duplicate `POST /order/:id/complete` → `stock` once; `SELECT status,count(*) FROM outbox_event GROUP BY status` shows `FAILED` retained; `GET /admin/outbox?status=FAILED` (if admin ops endpoint exists per Phase 11) lists them; logs contain `duplicate eventId=… skipped` and `outbox publish failed id=… nextRetryAt=` and `reservation transition already terminal`. No operation needs `grep client.emit inside manager` to prove idempotency — it is visible via DB state + logs + Swagger `409/200` semantics.

**Independent Test**: Spy ordering: `DataSource.transaction` → status check → inventory mutation only if `status==RESERVED/PENDING`. Run `npm run test -- --runInBand` (unit + integration) and `npm run build` green.

**Acceptance Scenarios**:
1. **Given** `POST /order/checkout → 201 pending`, **When** later `POST /order/:id/complete` retried twice, **Then** operator `psql SELECT stock,reservedAmount FROM inventory WHERE id=:id` shows single delta, and `GET /order/:id` `COMPLETED` both times, and logs show second call `already COMPLETED idempotent`.
2. **Given** RMQ outage `10m`, **When** outage ends, **Then** `SELECT outbox_event WHERE status=FAILED` retained and `SELECT WHERE status=SENT order by sentAt` shows eventual delivery without manual intervention.

---

### Edge Cases

- `Reservation` already `COMPLETED` then `expire`/`cancel` arrives late (checkout completion won race) → `200` idempotent (standardized Q2), zero `reserved-=qty`, zero `stock` delta.
- `Order` already `FAILED|CANCELLED|COMPLETED` then second `cancel`/`complete` → idempotent `200` (COMPLETED→COMPLETED) or `409` per `validateTransition` but never re-mutates inventory; `OUTBOX` not re-inserted for duplicate terminal transition (Phase 11 guard).
- `OutboxEvent` re-published after `SENT` update race (publish → RMQ ack → crash before `SENT`) → RMQ delivers duplicate `eventId` → `NotificationWorker` duplicate guard `eventId` → skip.
- `NotificationWorker` throws transient `SMTP 5xx` → BullMQ job `attempts 3` `backoff exponential` retries, second attempt sees `Redis SET NX` `0` for already-sent `<template>:<userId>` → skip duplicate `send`.
- `ReservationExpirationProcessor` Redis tick lock `SET NX expiration:tick:lock EX 30` existing → second instance skip tick entirely (no duplicate batch).
- `Inventory` `CHECK` `"reservedAmount" <= "stock"` / `"stock">=0` would fire if double-release subtracted → transaction rolls back `23514 → 409`, still idempotent because caller outside will not retry on `409`.
- `RESERVED` quantity larger than `reservedAmount` due to prior bug → `reserved-=qty` would go negative → `CHECK` `23514` → `409` and job poisoned quarantine `24h` after `3` attempts, not silently `reservedAmount -5`.
- Client retry without idempotency key header → server still idempotent via `status` check (no need for client `Idempotency-Key` per AGENTS — state is idempotent, not key-based for this phase; header `X-Request-Id` is tracing only `correlationId`).
- `RateLimitGuard 429` or `ValidationPipe 400` never creates business row, hence never needs idempotency dedup.
- `Payload` `jsonb` `FAILED` rows accumulated → retention `30d` purge job `DELETE WHERE status IN (SENT,FAILED) AND sentAt/createdAt < NOW()-30d` (ops, not during request).

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST classify retryable vs non-retryable operations and enforce bounded retry (derived from `docs/plan.md` §12 tasks + Phase 11 §8):
  | Category | Examples | Retryable? | Policy (V1) | On duplicate/non-retryable |
  |----------|----------|------------|-------------|----------------------------|
  | Reservation expiration `RESERVED→EXPIRED (+ Order PENDING→CANCELLED)` per candidate transaction | `ReservationExpirationService.processExpiredBatch` per-id `FOR UPDATE Reservation → FOR UPDATE sorted Inventories` | **Yes** — transient DB/RMQ (`ECONNREFUSED`, `ETIMEDOUT`) transient → retry | BullMQ `reservation-expiration` `attempts 3` + poison `3→quarantine 24h` (Redis `expiration:poison:count/quarantine`) already; outbox inserts inside retriable, but outer tick uses `attempts` not outbox retry | Duplicate after terminal `200 idempotent` (standardized Q2) → no retry, no inventory delta, not counted as poison |
  | Outbox publish `PENDING/PROCESSING→SENT` `FOR UPDATE SKIP LOCKED` batch 100 | `OutboxPublisher.publishBatch` → `client.emit` | **Yes** — RMQ `ECONNREFUSED/ETIMEDOUT` transient → retry | `attempts++` `nextRetryAt = NOW()+base*2^(attempts-1)` `base 1000ms` cap `60s` max `5` → `FAILED` retained (Phase 11 FR-010) `OUTBOX_*` configurable | Duplicate `eventId` already `SENT` not re-published; `FAILED` retained `30d` manual `requeue PENDING` |
  | Notification worker `order.created|completed|cancelled|reservation.expired` → `EmailProvider.send` + `NotificationLog` | `NotificationWorker.handle` / `notifications` BullMQ processor | **Yes** transient provider `5xx` → retry | BullMQ `notifications` `attempts 3` `backoff exponential` per job; second delivery duplicate `eventId` with Redis `SET NX notification:send:<template>:<aggregate>:<userId> EX 24h` → skip `send` | Duplicate `eventId` → `0` sends, ack `200`, not re-queued; permanent `400` invalid `userId` → `200` ack no retry |
  | Order completion `PENDING→COMPLETED + RESERVED→COMPLETED stock-=qty reserved-=qty` transaction | `POST /order/:id/complete` `OrderCompletionService.complete` `FOR UPDATE Order→Reservation→sorted Inventories` | **No server retry** — client may retry → server idempotent | On `409 already COMPLETED` return `200` idempotent (Phase 7 Q4) with zero `UPDATE Inventory`; on `409` other terminal `CANCELLED|FAILED|EXPIRED` `409` idempotent `0` delta; on transient `503` inside transaction → Rollback + `500`, client retries → same idempotent guard | Duplicate terminal → no new `OutboxEvent` (Phase 11 guard `if already COMPLETED return` → no insert) |
  | Inventory release on cancel/expire `RESERVED→CANCELLED|EXPIRED reserved-=qty` | `ReservationService.cancel/expire` `OrderCancellationService` `ReservationTransitionBuilder` | **No server retry** — worker/client retry → idempotent | First wins `reserved-=qty`, second sees `status != RESERVED` → `0` delta `200` (standardized Q2) | Double-subtract prevented by `if status!=RESERVED return` **before** any `Inventory` write, inside `FOR UPDATE Reservation` |
  | Validation/rate-limit `400/429` | `POST /order/checkout` cart empty `400`, `409` insufficient, `429` | **No retry** | `0` `OutboxEvent` rows (Phase 11 SC-007), no idempotency storage | Not idempotent — bug, not retry |
  All policies via `ConfigService` (`OUTBOX_*`, `EXPIRATION_*`, `notification` BullMQ `attempts`); `synchronize:false`.

- **FR-002**: System MUST make **Reservation Expiration idempotent** (`docs/plan.md` §12 example — already partially, now hardened + tested):
  ```text
  BEGIN
    SELECT Reservation WHERE id=:id FOR UPDATE
    // idempotent guard (before any Inventory lock)
    if status != 'RESERVED' → // already EXPIRED|COMPLETED|CANCELLED
      ROLLBACK or COMMIT no-op, return {status, alreadyTerminal:true}, do not INSERT outbox, do not UPDATE Inventory, log `reservation transition already terminal id=:id status=:s`
    // else RESERVED
    SELECT Inventory WHERE id IN (item.inventoryIds) FOR UPDATE (deterministic sortedIds)
    // business rule: verify expiresAt<=NOW() still true, else skip (not expired yet)
    if expiresAt > NOW() → skip no-op
    reservedAmount -= quantity per item (one UPDATE per Inventory)
    status = 'EXPIRED'
    if orderId and Order.status==PENDING: SELECT Order FOR UPDATE, Order PENDING→CANCELLED
    INSERT OutboxEvent reservation.expired (aggregateType Reservation) — only if transition happened
    if order cancelled: INSERT OutboxEvent order.cancelled reason:'expired' — only if order transition happened
  COMMIT
  ```
  Second attempt on same `id` must not execute `reserved-=qty` again. If concurrent `complete` won `RESERVED→COMPLETED` first, `expire` loser must also not `reserved-=qty` (loser sees `COMPLETED`). Preserve `ReservationTransitionBuilder` `transitionWithInventoryInternal` + poison `EXPIRATION_POISON*` logic already (max 3 → quarantine 24h) — do not weaken `FOR UPDATE` ordering `Reservation → sorted Inventories → Order`.

- **FR-003**: System MUST make **Notification Jobs idempotent** (Phase 11 at-least-once duplicate tolerance):
  - Envelope carries `eventId=OutboxEvent.id`, `eventType`, `version:1`, `correlationId`, `payload {orderId, userId, reservationId, ...}`.
  - `NotificationWorker` (RMQ `@EventPattern` or BullMQ `notifications` processor `concurrency 5`) MUST guard:
    ```ts
    // Option A: Redis idempotency key (V1 for sales/bulk)
    const key = `notification:send:${template}:${aggregateId}:${userId}` // or `notification:processed:${eventId}`
    const first = await cacheManager.set(key, '1', 86400000, {nx: true}); // SET NX EX 24h
    if (!first) { Logger.log(`duplicate eventId=${eventId} skipped`); return; }
    // Option B: idempotent status check for Order/Reservation if operation would read DB
    if (alreadyProcessed(eventId)) return;
    await emailProvider.send(...); // only if first
    await notificationLogRepo.save({userId, template, aggregateId, messageId}); // only if first
    ```
  - V1 `NoopEmailProvider` naturally idempotent (log only), but guard MUST exist so future `SMTP` does not double-send after publisher retry race (`publish → ack → crash before SENT → re-publish → duplicate delivery`).
  - BullMQ bulk `sendBulk` must `SET NX` per `<template>:<campaignId>:<userId>` before `send`, and second bulk retry skips first-5 already `NX 0`.
  - No `Inventory`/`Order`/`Reservation` mutation inside worker; `Logger` only with `eventId` `correlationId` prefix.

- **FR-004**: System MUST prevent **Duplicate Order Completion** (`docs/plan.md` Phase 7 already idempotent `COMPLETED→COMPLETED 200`, Phase 12 re-verifies + extends to inventory guard):
  ```text
  BEGIN
    SELECT Order WHERE id=:id FOR UPDATE
    // idempotent guard
    if Order.status == 'COMPLETED' → return {status:COMPLETED} 200, no Inventory UPDATE, no duplicate OutboxEvent (Phase 11 guard)
    if Order.status != 'PENDING' → throw 409 Already terminal (CANCELLED|FAILED|EXPIRED) — also idempotent 0 delta
    assertOwner
    SELECT Reservation WHERE orderId=:id FOR UPDATE
    if Reservation.status != 'RESERVED' → 409 — 0 delta (complete vs expire loser)
    SELECT Inventory WHERE id IN (...) FOR UPDATE sorted
    // only now mutate
    stock -= qty; reserved -= qty per item
    Reservation RESERVED→COMPLETED
    Order PENDING→COMPLETED
    INSERT OutboxEvent order.completed — only if transition happened
  COMMIT
  ```
  Concurrent `complete` vs `complete` → `FOR UPDATE Order` serializes → first commits `stock-=qty`, second sees `COMPLETED` → `0` delta. `23514 CHECK → 409` backstop. Service must be tested with `supertest` duplicate `POST /order/:id/complete` twice same `jwt`.

- **FR-005**: System MUST prevent **Duplicate Inventory Release** (`RESERVED` → `CANCELLED|EXPIRED` vs `RESERVED` → `COMPLETED` split):
  - `reservedAmount -= qty` **only** when `Reservation.status` was `RESERVED` at `FOR UPDATE` time. `cancel` and `expire` share the guard: `if status != RESERVED → 0 delta`. `complete` does `stock-=qty reserved-=qty` **only** when `Order PENDING && Reservation RESERVED`.
  - No path may do unconditional `UPDATE inventory SET reservedAmount = reservedAmount - :qty` without prior `status` check inside same `FOR UPDATE` transaction.
  - DB CHECKs `reservedAmount>=0`, `reservedAmount<=stock`, `stock>=0` remain as final backstop — violation `23514 → 409` not hidden, and should trigger poison quarantine for expiration worker (attempt `1..3`).
  - `InventoryService` `decreaseStockForOrderMany`/`restoreStockForOrderMany` already `EntityManager`-owned — callers must not call them outside idempotent guard.

- **FR-006**: System MUST define **Event/Job Retry Behavior** (bounded, exponential, observable, distinct layers):
  ```text
  Layer A: PostgreSQL Outbox Publisher (Phase 11 — durable)
    trigger: PENDING.nextRetryAt<=NOW() or PROCESSING lease expired (30s)
    claim: FOR UPDATE SKIP LOCKED batch 100 ORDER BY createdAt ASC
    try: client.emit(eventType, persisted payload) await lastValueFrom
    on success: status=SENT sentAt=NOW() lastError=NULL processingStartedAt=NULL
    on transient failure (ECONNREFUSED, ETIMEDOUT, 503): attempts++ nextRetryAt = NOW()+min(base*2^(attempts-1), cap) base 1s cap 60s, status=PENDING
    on maxAttempts 5: status=FAILED retained (not deleted) lastError truncated 1000
    on RABBITMQ_URL empty: skip publish, leave PENDING (no loss)
    lease: processingStartedAt < NOW()-30s reclaimable

  Layer B: Reservation Expiration BullMQ (Phase 5)
    trigger: repeat 30s (EXPIRATION_CRON) concurrency 1 + Redis SET NX expiration:tick:lock EX 30s single-winner
    per-candidate: FOR UPDATE Reservation → ... → idempotent guard → 0 or 1 transition per id per tick
    on DB transient: BullMQ job attempts 3 backoff exponential, after 3 poison count++ → quarantine 24h (expiration:poison:count + expiration:poison:quarantine EX 86400) — tick skipped while quarantined (idempotent `200 already terminal` and `404` not counted toward poison, per Q3 — only `23514`/`ETIMEDOUT`/`ECONNREFUSED`/`500`)

  Layer C: Notification Worker BullMQ notifications (Phase 11 bridge, Phase 12 idempotency)
    trigger: outbox → RMQ → worker @EventPattern / Bull queue add
    try: SET NX notification:send:... EX 24h → if 0 skip; else EmailProvider.send → NotificationLog INSERT → ACK
    on transient provider 5xx: Bull job attempts 3 backoff exponential, duplicate eventId still idempotent on retry
    on permanent 400/404: ACK without retry (skip)

  Layer D: Business HTTP (checkout/complete/cancel) — NO server-side retry
    client may retry → server idempotent via status guard (FR-004/FR-005), no BullMQ
  ```
  All delays `ConfigService` (`OUTBOX_BATCH_SIZE=100`, `OUTBOX_POLL_INTERVAL_MS=1000`, `OUTBOX_PROCESSING_LEASE_MS=30000`, `OUTBOX_MAX_ATTEMPTS=5`, `OUTBOX_RETRY_BASE_MS=1000`, `OUTBOX_RETRY_MAX_MS=60000`, `OUTBOX_RETENTION_DAYS=30`, `EXPIRATION_CRON`, `EXPIRATION_MAX_RETRIES=3`). No `client.emit` inside any `manager` `dataSource.transaction`.

- **FR-007**: System MUST define **Failure Handling** (no lost event, no partial inventory mutation, observable):
  - Transactional business failures `409` (already terminal, insufficient `available`, `CHECK 23514`) roll back entirely via `manager` → `AllExceptionsFilter` serializes `{statusCode,message,timestamp}` `409`/`400`/`404` — caller sees `409`, no `OutboxEvent` row inserted on rollback (Phase 11 guard), retrying yields same `409` or idempotent `200`.
  - Publisher `FAILED` after `maxAttempts` → row retained `status FAILED attempts 5 lastError` with `CHECK attempts>=0`, queryable `GET /admin/outbox?status=FAILED` (Admin list, Phase 11 optional now required for ops) and requeueable via `PATCH /admin/outbox/:id/requeue` (`JwtGuard @Auth(Admin)` `200` resets `status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL`; `404` if not `FAILED`, `403` if not Admin). Manual `psql UPDATE outbox_event SET status='PENDING' ...` remains fallback.
  - Expiration poison `3` → `quarantine 24h` → next ticks log `expiration quarantined <remaining>s` and skip `processExpiredBatch` entirely to avoid hot-loop.
  - All status transitions log via injected `Logger` (never `console.log`): `Logger.log reservation idempotent skip id=:id status=:s`, `Logger.warn outbox publish failed id=:id attempts=:n nextRetryAt=:iso msg=:prefix`, `Logger.log notification duplicate eventId=:id skipped`, `Logger.warn expiration quarantine hits`. Each idempotent skip **also** increments counter `CACHE_MANAGER INCR idempotency:duplicate:skipped:<type>` (`notification`|`expiration`|`complete`|`cancel`) `EX 86400` (or Prometheus `idempotency_duplicate_skipped_total{type}` if exporter exists) for dashboards — log + counter per Q5 Option B. `lastError` truncated `1000`, never logs `payload` PII (`email`, `token`, `clientSecret`).
  - `AllExceptionsFilter` never catches publisher/worker background throw as `500` HTTP; publisher throw does not leak to checkout `201`.
  - Metrics placeholder `RATE_LIMIT_FAIL_OPEN_METRIC` and future `api:health` counters remain fail-open; idempotency `SET NX` and counter `INCR` on Redis down → `Logger.warn Redis fail-open for idempotency: <msg>` + allow `send` once (availability over strict dedup — duplicate possible but rare, better than lost send).

- **FR-008**: System MUST preserve **Idempotency via status check or dedup key, not via client-provided `Idempotency-Key` header** for V1 (client tracing `X-Request-Id` → `correlationId` is tracing only, not dedup). Idempotency keys in system:
  - `OutboxEvent.id == payload.eventId` (`uuid`) is the at-least-once dedup key for notifications.
  - `notification:send:<template>:<aggregate>:<userId>` (Redis `SET NX EX 24h`) for bulk idempotency.
  - `Reservation.status` / `Order.status` is the business idempotency guard for inventory mutations.
  - Optional future `NotificationLog (userId, template, aggregateId)` unique or `ProcessedEvent(eventId)` table if Redis loss would cause duplicate — V1 Redis `24h` is sufficient; PG `NotificationLog` unique guard may double as fallback.

- **FR-009**: System MUST provide **Tests proving idempotency** (per Testing Rules §6 — unit mocked, integration real PG + real Redis when available, E2E `supertest --runInBand`):
  - **Unit (mock `DataSource`/`EntityManager`, `Manager.getRepository` spies, `CacheManager` mock, `EmailProvider` mock, `ClientProxy` mock):**
    - Expiration idempotent: `expire` mocked `Reservation RESERVED→EXPIRED` first `UPDATE Inventory reserved-=qty 1`, second with `status EXPIRED` `0` `UPDATE`, return `200` without `reserved-=qty`.
    - Complete idempotent: `complete` first `COMPLETED stock-=qty 1`, second with `status COMPLETED` `0` mutation, `200` same `Order`.
    - Cancel idempotent: `cancel` first `CANCELLED reserved-=qty 1`, second `CANCELLED` `0`.
    - Complete vs expire race: mocked `FOR UPDATE` order → `status PENDING` first wins `COMPLETED`, second sees `COMPLETED` `409` `0` delta.
    - Notification duplicate: `handle(eventId=abc)` twice → `send` `1` not `2`, second `duplicate skipped` log.
    - Retry policy: `publishBatch` transient `ECONNREFUSED` → `attempts 1 nextRetryAt +1s`, `5 → FAILED` retained, `PROCESSING` lease `60s old → reclaimed`.
    - No `client.emit` inside `dataSource.transaction` (grep `0`).
  - **Integration (real PG via `docker-compose` PG 17, `synchronize:false`, real `Inventory` `CHECK`s, real `FOR UPDATE` + `SKIP LOCKED`, `FLUSHDB` for Redis):**
    - Expiration double: real `Inventory stock 10 reserved 2` + `Reservation RESERVED qty2` → `processExpiredBatch` once `EXPIRED reserved 0`, second `processExpiredBatch` with same `id` `0` delta `reserved 0 stock 10`.
    - Concurrency: `Promise.all([expire(id), expire(id)])` with real `FOR UPDATE Reservation` → one `200` `EXPIRED`, one `409/200` `0` delta, `reservedAmount` decremented exactly once (`EXPLAIN` shows `FOR UPDATE`).
    - Also `Promise.all([expire(id), cancel(id)])` disjoint — one wins, `reserved` single decrement.
    - Complete duplicate: `POST /order/checkout → Order PENDING reserved 2` → `POST /order/:id/complete` twice `supertest` sequential → first `200 COMPLETED stock 8`, second `200 COMPLETED stock 8` `UpdateInventory` spy `1` total.
    - `complete` vs `expire` concurrency `2` promises with same `orderId/reservationId` → `stock` decremented at most once, `COMPLETED` vs `EXPIRED` first winner.
    - Notification duplicate with real Redis `SET NX`: publish `order.created eventId` twice to `NotificationWorker` → `EmailProvider` mock `send` `1`, second `0` (or `NotificationLog` `1` not `2`).
    - Outbox publisher duplicate delivery real PG: create `OutboxEvent PENDING` → `publishBatch` success `SENT`, then republish same `eventId` (simulate lease race) → consumer `duplicate skipped`.
  - **E2E (supertest `test/app.e2e-spec.ts` `Test.createTestingModule` `supertest(app)`):**
    - `register → login → add cart qty2 → POST /order/checkout 201 pending` → admin `POST /reservations/:id/expire` once `200 EXPIRED` → `GET /inventory/:productId` `reserved 0 available 10` → same `expire` again `200` idempotent (Q2) → `GET /inventory` still `reserved 0`.
    - Same checkout → `POST /order/:id/complete` once `200 COMPLETED stock 8` → same `complete` again `200 COMPLETED stock 8` → `GET /order/:id` `COMPLETED` `GET /outbox?aggregateId` `SENT` count `1` `order.completed`.
    - `POST /order/checkout` → publisher publishes `order.created` `eventId` twice via re-queue (`UPDATE outbox_event SET status='PENDING' WHERE id=:id` then `publishBatch`) → `NotificationWorker` logs `duplicate` and `EmailProvider` not double-sent.

- **FR-010**: System MUST remain **thin & documented** per `AGENTS.md` §3 Code Documentation: every new or modified `Service`/`Controller`/`Guard`/`Entity` gets class-level `/** This service is responsible for ... It handles ... and enforces ... */`; every public method `/** ... @param @returns @throws */`; every complex condition (`if status != RESERVED`, `available = stock - reservedAmount`, `attempts>=max`, `lease expired`) has inline `//` intent comment; `Logger` injected not `console.log`; config via `ConfigService`.

### Key Entities

- **Reservation**: `id uuid PK`, `userId FK CASCADE`, `orderId FK SET NULL`, `status enum RESERVED|COMPLETED|EXPIRED|CANCELLED`, `expiresAt timestamptz`, indexes `(status, expiresAt)` + `userId` + `status`. Idempotency guard: `status==RESERVED` before any `reserved-=qty`. Transition `RESERVED→*` is one-way.

- **ReservationItem**: `id uuid PK`, `reservationId FK CASCADE`, `inventoryId FK CASCADE`, `quantity int CHECK>0`, `@Unique([reservationId, inventoryId])`. Used only via `Reservation` transaction.

- **Inventory**: `id uuid PK`, `productId FK CASCADE @Unique`, `stock int CHECK>=0`, `reservedAmount int CHECK>=0 CHECK<=stock`, `available` derived `stock - reservedAmount` (never persisted, getter `get available()`). Only mutated inside `FOR UPDATE Reservation → FOR UPDATE sorted Inventories` with idempotent guard.

- **Order**: `id uuid PK`, `userId FK CASCADE @Index`, `status enum PENDING|COMPLETED|CANCELLED|FAILED @Index`, `total int CHECK>=0`, `createdAt`. Idempotent guard: `status==PENDING` before `PENDING→COMPLETED|CANCELLED|FAILED`; `COMPLETED→COMPLETED` returns `200` `0` delta.

- **OrderItem**: `id uuid PK`, `orderId FK CASCADE`, `productId FK RESTRICT`, `quantity CHECK>0`, `unit_price CHECK>=0`, `@Unique([orderId, productId])` `subtotal` generated.

- **OutboxEvent**: `id uuid PK == payload.eventId`, `eventType varchar order.created|completed|cancelled|reservation.expired @Index`, `aggregateType Order|Reservation`, `aggregateId uuid @Index (no hard FK, retained after business row delete)`, `payload jsonb {version:1, eventId, eventType, occurredAt, correlationId, ...business} CHECK payload->>'version' IS NOT NULL`, `status enum PENDING|PROCESSING|SENT|FAILED`, `attempts int CHECK>=0`, `nextRetryAt timestamptz`, `lastError varchar 1000 nullable`, `processingStartedAt nullable` lease, `createdAt`, `sentAt nullable`. Indexes ` (status, nextRetryAt, createdAt)` composite + `createdAt DESC`. `attempts`+`nextRetryAt` drive retry; `FAILED` retained `30d` purge.

- **NotificationLog** (optional audit, idempotency double-check): `id uuid PK`, `userId FK CASCADE @Index`, `template varchar verify|reset|sales|new_product|order`, `subject varchar`, `aggregateId uuid nullable @Index` (e.g., `orderId`), `eventId uuid @Index @Unique` (dedup), `provider varchar noop|smtp`, `messageId varchar nullable`, `sentAt @CreateDateColumn`. Used as fallback guard if Redis `SET NX` lost.

- **Idempotency Redis Keys** (ephemeral, 24h):
  ```text
  notification:send:<template>:<aggregateId>:<userId> → 1  EX 86400 SET NX
  notification:processed:<eventId> → 1 EX 86400 SET NX (alternative single dedup)
  expiration:tick:lock → 1 EX 30 SET NX (single-winner tick)
  expiration:poison:count / quarantined EX 86400
  rl:* (rate limit, existing)
  ```

- **Retry Policy** (config, not entity): `{ maxAttempts, baseDelayMs, maxDelayMs, backoff: base*2^(n-1) capped, leaseMs }` applied per layer A/B/C as `FR-006`. Stored in `ConfigService` not DB.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001 (Expiration idempotency)**: Reprocessing the same `Reservation RESERVED qty2 reserved 2 stock 10` via `POST /reservations/:id/expire` or `ReservationExpirationService.processExpiredBatch` a second time leaves `Reservation EXPIRED` and `Inventory stock 10 reserved 0 available 10` unchanged (second `UPDATE Inventory` `0` rows, second response `200 already terminal` (Q2) `reservedAmount` not ` -2`), verified by integration `SELECT reservedAmount, stock` before/after and unit `Manager.update` spy `1` total. Concurrency `Promise.all([expire, expire])` also single decrement.

- **SC-002 (Notification idempotency)**: Delivering the same `eventId=OutboxEvent.id` `order.created|reservation.expired` twice to `NotificationWorker` calls `EmailProvider.send` exactly once and `NotificationLog INSERT` exactly once, second delivery logs `duplicate eventId=<prefix> skipped` and returns `200` ack with `Inventory`/`Order` spies `0`. Verified by unit mock `sendCalls==1` and integration real Redis `SET NX 1 then 0`.

- **SC-003 (Order completion idempotency)**: Calling `POST /order/:id/complete` (or `PATCH` alias) twice sequentially or concurrently on `Order PENDING reserved 2 stock 10 qty2` decrements `stock 10→8 reserved 2→0` exactly once; second call returns `200 {status:COMPLETED}` with `Inventory.stock` still `8` and creates zero additional `UPDATE Inventory` and zero duplicate `OutboxEvent order.completed`. Verified by integration `SELECT stock,reservedAmount` + `SELECT count(*) FROM outbox_event WHERE aggregateId=:orderId AND eventType='order.completed'` `=1`.

- **SC-004 (Inventory release no double-subtract)**: For `Reservation RESERVED qty2 reserved 2` executing `cancel` then `expire` (or `cancel` vs `expire` concurrent `Promise.all`) `reservedAmount` transitions `2→0` once, second loses `status != RESERVED` guard and leaves `reserved 0 stock 10`, `CHECK reservedAmount>=0` never violated `23514 0` in trajectory, final `status` is first winner (`CANCELLED` or `EXPIRED`).

- **SC-005 (Client retry after timeout)**: A client `POST /order/checkout` that times out but committed `Order PENDING + OutboxEvent PENDING` and a client `POST /order/:id/complete` retried after `200` timeout both yield idempotent second `200` with no duplicate rows nor double inventory delta, verified by `supertest` double `POST` and `psql` counts.

- **SC-006 (Retry bounded)**: With transient `ECONNREFUSED` on `OutboxPublisher.client.emit`, publisher shows `attempts 1→5` `nextRetryAt` `+1s,+2s,+4s,+8s,+16s` capped `60s`, `status FAILED` retained not deleted, `SELECT WHERE status='FAILED'` non-empty after `maxAttempts`, manually requeue `UPDATE status=PENDING` re-publishes. `ReservationExpiration` poison `3→quarantine 24h` with next ticks skipped.

- **SC-007 (At-least-once → idempotent end-to-end)**: A full flow `register → cart qty1 available 5 → checkout 201 PENDING reserved 1 → publisher SENT → notification duplicate delivery → verify ` already processed → complete 200 COMPLETED stock-1 → complete retry 200 idempotent → expiration no-op → `GET /inventory available` equals expected single delta. No `Order`/`Inventory` mutation inside worker.

- **SC-008 (No regression, textbook transaction)**: `grep -c "client.emit" src/modules/order/order-checkout.service.ts` `0` and `grep -c "FOR UPDATE" src/modules/reservation/reservation-expiration.service.ts` `>=2` and `grep -c "if.*status.*!=" src/modules/order/order-completion.service.ts` `>=1`; `npm run build` passes, `npm run test -- --runInBand` (unit + integration + E2E `supertest`) passes `synchronize:false`, `AllExceptionsFilter` forwards `409`/`200` correctly, rate-limit `429` creates zero `OutboxEvent`.

---

## 5. Assumptions

- **A1**: Phases 1–11 are as documented: `PostgreSQL` `synchronize:false` with migrations `1755800000000`–`17559xxxxx` intact (never edited), `Inventory CHECKs` + `available` derived, `Reservation FOR UPDATE` sorted ids + deterministic lock ordering + `status` composite index, `Order checkout-only` `POST /order/checkout {}` `POST /order/:id/complete` idempotent `COMPLETED→COMPLETED`, `reservation-expiration` BullMQ `30s` + Redis `SET NX` lock + poison, `OutboxEvent` `FOR UPDATE SKIP LOCKED` batch 100 lease 30s `SENT/FAILED` `30d`.
- **A2**: PostgreSQL remains source for `Inventory/Reservation/Order/OutboxEvent`; Redis is cache/lock only (`SET NX EX`), RabbitMQ is transport only; none are used for idempotency beyond `24h` `SET NX` dedup (fallback `NotificationLog` unique if added).
- **A3**: Second attempts are **state-checked** (`status != RESERVED/PENDING → 0 delta`) not header-keyed; `X-Request-Id`/`X-Correlation-Id` → `correlationId` is tracing only, not dedup for this phase.
- **A4**: `RateLimitGuard` outermost, `ValidationPipe` whitelist/forbidNonWhitelisted → `400/429` create zero business rows, hence zero idempotency work; `AllExceptionsFilter` serializes `409/400/404` as `{statusCode,message,timestamp}`.
- **A5**: Natural idempotency `COMPLETED→COMPLETED 200` (Q4) and immediate admin `expire` (Q1) and `CANCELLED/EXPIRED→* 409` (Q5) per Phase 4 clarifications remain — Phase 12 does not change HTTP semantics, only adds the inventory-guard proof and cross-path `complete` vs `expire` race handling.
- **A6**: `InventoryService` is sole mutator of `stock/reservedAmount`; other modules call via `EntityManager`-owned helpers (`reserve`/`releaseReservation`/`completeSale` style) inside `dataSource.transaction` with `FOR UPDATE` — Phase 12 does not add direct `@InjectRepository(Inventory)` outside transaction.
- **A7**: Tests use mocked `ClientProxy`/`EmailProvider`/`CacheManager` for unit; real PG 17 + real Redis (when available) with `FLUSHDB` for integration; `--runInBand` for `FOR UPDATE`/`SKIP LOCKED` determinism.
- **A8**: No new client `Idempotency-Key` header required V1; no `Payment`/`EmailVerificationToken` provider needed for this phase (future Phases 17–19 may reuse idempotency pattern but out of scope).
- **A9**: `OUTBOX_*` + `EXPIRATION_*` config via `ConfigService` with defaults `BATCH_SIZE=100 POLL=1000 LEASE=30000 MAX=5 BASE=1000 MAX_MS=60000 RETENTION=30` clamped `>=60000` window else fallback + `Logger.warn`.

---

## 6. Dependencies

- Phases 0–11 modules: `InventoryModule` (`InventoryService`), `ReservationModule` (`ReservationService`, `ReservationExpirationService/Processor`, `ReservationTransitionBuilder`), `OrderModule` (`OrderCheckoutService`, `OrderCompletionService`, `OrderService`), `CartModule`, `AuthModule` (`Auth`, `JwtGuard`, `RateLimitGuard`), `ProductsModule` (readonly `stock` already removed), `OutboxModule` (`OutboxService`, `OutboxPublisher`).
- `AppModule` infra: `TypeOrmModule` global `DataSource`, `BullModule` shared `REDIS_URL` (queues `reservation-expiration`, `outbox-publish` optional, `notifications`), `ClientsModule NOTIFICATION_SERVICE` `RABBITMQ_URL/RABBITMQ_QUEUE`, `CacheModule` (`CACHE_MANAGER` `createKeyv` `REDIS_URL` for `SET NX`), `ConfigModule`.
- Global `ValidationPipe`, `AllExceptionsFilter`, `Logger`, `RateLimitGuard` per AGENTS.md.

---

## 7. Out of Scope (this phase)

- New business state (`Payment` Stripe, `EmailVerificationToken`, `RefreshToken`, `Dashboard` RBAC/metrics, `Client Idempotency-Key` header dedup table) — reuse status-guard pattern only, do not implement those modules here.
- Changing checkout from cart-only to explicit `items[]` or changing `COMPLETED→COMPLETED` semantics from `200` idempotent to `409`.
- Adding `ProcessedEvent` persistent dedup table beyond optional `NotificationLog(eventId @Unique)` — V1 `Redis SET NX 24h` + status guard suffices; persistent table is optimization if Redis loss proven.
- Outbox schema change beyond documenting idempotency (Phase 11 migration `17559xxxxxx-CreateOutboxEvent` is already authoritative).
- Bulk stock `POST /admin/stock/bulk` (Phase 20 dashboard) — not part of reliability.
- Real Stripe `sk_live` or SES/SMTP `send` in CI — use `NoopEmailProvider`/`NoopStripeClient`; tests assert `send` spy not network.
- Refund `stock+=qty` after `COMPLETED` sale (Phase 8 `PENDING→CANCELLED` only `reserved-=qty`, post-sale refund `stock+=` is Phase 8 semantics, not duplicated here).

---

## 8. Clarifications

### Session 2026-09-23 (Phase 12 kickoff)

- Q: Which operations are retryable? → **A: Only `OutboxPublisher.client.emit`, `ReservationExpirationProcessor` per-candidate DB transact, and `NotificationWorker/EmailProvider.send` transient provider failures are retried (with backoff + cap + retained FAILED/quarantine). Business `POST /order/checkout/complete/cancel/expire` are never server-retried; client may retry → server handles idempotently via `status` guard with zero second inventory delta.**
- Q: Should second idempotent `expire` on already `EXPIRED` return `200` or `409`? → **A: `200` idempotent success — standardized per clarification 2026-09-23 Q2 (Option A). Second `expire`/`cancel` on already terminal (`EXPIRED|CANCELLED|COMPLETED`) returns `200 {status}` with `0` inventory delta and `Logger.log already terminal`; `409` reserved only for truly invalid transitions (e.g., `COMPLETED→EXPIRED`).**
- Q: Does notification idempotency need a persistent `processed_event` table? → **A: No — V1 `Redis SET NX notification:send:... EX 24h` + optional `NotificationLog eventId @Unique` fallback is sufficient. If Redis `FLUSHDB` purges keys, duplicate `send` on retry after >24h is bounded and acceptable per ops (sales campaigns are not critical). Add `processed_event` only if `EXPLAIN` shows Redis loss causing duplicate in audit.**
- Q: Retry delays and caps? → **A: Reuse Phase 11 defaults `OUTBOX base 1s cap 60s max 5 lease 30s batch 100 poll 1s`, `reservation-expiration` BullMQ `attempts 3 quarantine 24h`, `notifications` BullMQ `attempts 3`. All `ConfigService` configurable without code change.**
- Q: `X-Request-Id` correlationId dedup? → **A: No — correlationId is tracing only (`payload.correlationId` preserved by outbox). Idempotency is state-based (`Reservation.status`, `Order.status`, `eventId`/`SET NX`), not header-based, so plain `supertest` retry without key remains idempotent.**
- Q: Does Phase 12 require admin requeue API for FAILED outbox? → **A: Yes — Option B — add `PATCH /admin/outbox/:id/requeue` `JwtGuard @Auth(Admin)` only, resets `status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL` for that `id` (single-entity, not bulk). No bulk `POST /admin/outbox/requeue-failed` and no auto-requeue in V1; manual `psql UPDATE` remains fallback but HTTP is the documented ops path. Swagger documents `200` on success, `404` if not `FAILED`, `403` if not Admin.**
- Q: Should idempotent second `expire`/`cancel` be standardized to single HTTP code? → **A: Yes — Option A — `200` idempotent success for already terminal (`EXPIRED|CANCELLED|COMPLETED`) with `0` delta; `409` only for invalid transitions. Standardizes `supertest expect(200)` on retry.**
- Q: Should poison/quarantine count idempotent `200 already terminal` as failure? → **A: No — Option A — exclude `200` idempotent (and `404` not-found) from `expiration:poison:count`; count only transient `DB`/`23514`/`ETIMEDOUT`/`ECONNREFUSED`/`500` toward `3 → quarantine 24h`. Prevents false quarantine on healthy re-scans.**
- Q: Should `sendBulk` retry re-scan full eligible set with `SET NX` skip or checkpoint cursor? → **A: Yes — Option A — re-scan full eligible `SELECT WHERE marketingOptIn` each retry + per-user `SET NX notification:send:sales:c1:<userId> EX 24h` skip (`0`→skip, `1`→send); no checkpoint cursor, `NotificationLog` unique fallback.**
- Q: Should idempotent skips emit metric/counter or log-only? → **A: Option B — Log + counter — `Logger.log`/`Logger.warn` for each `duplicate eventId`/`already terminal` skip **plus** `CACHE_MANAGER INCR idempotency:duplicate:skipped:<type>` (e.g., `notification`, `expiration`, `complete`) `EX 86400` or Prometheus `idempotency_duplicate_skipped_total{type}`; Redis down → `Logger.warn` fail-open but log remains.**

---

## 9. Acceptance Scenarios (for planning)

1. Expiration idempotent: `RESERVED qty2 → expire → EXPIRED reserved 0` then same `expire → 0 delta reserved 0`.
2. Notification idempotent: `eventId duplicate → send 1 not 2`, Redis `SET NX 0` skip.
3. Completion idempotent: `PENDING→COMPLETED stock-=qty once` then second `complete 200` `stock` unchanged `outbox 1`.
4. Inventory release no double: `cancel vs expire race → reserved-=qty once`, `CHECK` holds.
5. Client retry idempotent: timed-out `checkout 201` + retried `complete` → second `200` no double delta.
6. Retry bounded: `ECONNREFUSED → attempts 1..5 → FAILED retained`, poison `3→quarantine 24h`.
7. At-least-once end-to-end: duplicate publisher race → consumer `duplicate skipped` `0` inventory mutation.
8. No regression: `client.emit` outside `manager`, `FOR UPDATE` sorted ids, `status` guard present, `build/test --runInBand` green `synchronize:false`.

