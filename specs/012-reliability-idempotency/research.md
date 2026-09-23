# Research: Reliability / Idempotency — Phase 12

**Feature**: `012-reliability-idempotency` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` resolved — Technical Context has `0` unknowns. Research covers the 5 interactive clarifications (Q1-Q5) plus 3 additional design decisions that affect task decomposition but were already implicit in spec.

---

## D1 — HTTP Status for Idempotent Second Same-Transition (`200` vs `409`)

**Decision**: `200` idempotent success for already-terminal **same** transition (`RESERVED→EXPIRED` second `expire` on `EXPIRED`, `RESERVED→CANCELLED` second `cancel` on `CANCELLED`, `PENDING→COMPLETED` second `complete` on `COMPLETED`) with `0` inventory delta and `Logger.log already terminal id=:id status=:s`; `409` reserved only for **conflicting** cross-transition (`COMPLETED→EXPIRED`, `EXPIRED→COMPLETED`, `CANCELLED→COMPLETED`) per `validateTransition`.

**Rationale**: Makes client retry after timeout transparent (`supertest` `expect(200)` on retry), matches Phase 7 precedent `COMPLETED→COMPLETED 200` (Q4), keeps `AllExceptionsFilter` contract `200` = success idempotent vs `409` = invalid state machine. Prevents flaky `expect([200,409])`.

**Alternatives considered**:
- `409` for all already-terminal (Phase 4 Q5 literal) — rejected: forces caller to treat conflict as success, complicates E2E.
- `204` No Content — rejected: loses `status` body useful for operator verify.
- Keep ambiguous `200|409` — rejected: non-deterministic contract.

---

## D2 — Poison / Quarantine Exclusion for Idempotent `200`/`404`

**Decision**: `expiration:poison:count` increments **only** on transient `DB` failures (`23514 CHECK` violation, `ETIMEDOUT`, `ECONNREFUSED`, `500`, `queryFailedError`); `200` idempotent (`already EXPIRED`/`CANCELLED`/`COMPLETED`) and `404` not-found (stale `reservationId` re-scan after delete) are **not** counted toward `3 → quarantine 24h`.

**Rationale**: Prevents false quarantine when worker re-scans same `EXPIRED` candidate every `30s` tick (`WHERE status=RESERVED AND expiresAt<=NOW()` ideally excludes `EXPIRED`, but if tick races with `expire` the guard returns `200` — should not poison). Preserves `3 → quarantine` as true poison signal for `CHECK` loop.

**Alternatives**:
- Count `409` as poison — rejected: `409` conflicting transition is also non-transient (business already terminal) → false quarantine.
- Count all non-`200` — rejected: would quarantine on healthy `200` scans.
- No quarantine at all — rejected: hot-loop on real `CHECK` bug would spam `FOR UPDATE`.

---

## D3 — `PATCH /admin/outbox/:id/requeue` Admin-Only Single-Entity (Q1 B)

**Decision**: Add `OutboxAdminController` `@Controller('admin/outbox')` `@UseGuards(JwtGuard, RolesGuard)` `@Auth(UserRoles.Admin)` `PATCH ':id/requeue'` → `OutboxService.requeue(manager, id)`: `SELECT OutboxEvent WHERE id=:id FOR UPDATE` check `status==FAILED` else `404`/`409`, then `UPDATE status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL` inside `DataSource.transaction`, return `200 {id, status:PENDING}`; `GET /admin/outbox?status=FAILED` list optional (Phase 11 admin list now required). No bulk `POST /admin/outbox/requeue-failed` in V1, no auto-requeue.

**Rationale**: Gives operators auditable HTTP replay without direct `psql` in prod, RBAC-guarded (`Admin` only `403` else), single-entity keeps scope minimal (bulk added if `FAILED` volume proves high). Matches existing `GET /admin/...` admin ops pattern. `psql UPDATE` remains fallback for emergency.

**Alternatives**:
- No endpoint, manual `psql` only — rejected: requires DB creds in prod, not auditable via `Logger`.
- Bulk `requeue-failed` — rejected: widened scope, risk of thundering herd replay.
- Auto-requeue after retention — rejected: hides poison needing inspection.

**Implementation note**: `requeue` uses `manager.getRepository(OutboxEvent)` with `FOR UPDATE` to avoid race with concurrent publisher claim (`SKIP LOCKED`).

---

## D4 — Bulk `sendBulk` Retry: Re-scan Full Set with `SET NX` vs Checkpoint Cursor (Q4 A)

**Decision**: Retry re-scans **full** eligible `SELECT users WHERE marketingOptIn=true AND emailVerified=true` and per-user `await cacheManager.set(`notification:send:${template}:${campaignId}:${userId}`, '1', 86400000, {nx:true})` → if `0` (already `NX` from prior attempt) skip `EmailProvider.send`, else send. No `lastProcessedUserId` checkpoint persisted in `Bull Job progress`.

**Rationale**: Stateless, idempotent, no extra `Job progress` table, tolerates `BullMQ attempts 3` retry by natural `SET NX 0` skip, `NotificationLog eventId @Unique` provides PG fallback if Redis `FLUSHDB` purges keys (second retry after `24h` still single `Log` row). Checkpoint cursor would need `Job updateProgress` + `WHERE id > :cursor` and complicates `WHERE marketingOptIn` filter.

**Alternatives**:
- Checkpoint cursor `WHERE id > :cursor` — rejected: cursor invalid if `users` inserted between retries, needs extra state.
- `WHERE NOT EXISTS (SELECT 1 FROM notification_log ...)` — rejected: heavier join per user vs cheap `SET NX`.
- Fail-all retry resends all 10 — rejected: duplicates.

---

## D5 — Log + `INCR` Counter for Idempotent Skips (Q5 B)

**Decision**: Every idempotent skip does **both** `Logger.log`/`Logger.warn` (existing) **plus** `await cacheManager.set`/`incr` pattern for counter: `await cacheManager.getStore().increment('idempotency:duplicate:skipped:notification' | 'expiration' | 'complete' | 'cancel')` or `cacheManager.set(key, 1)` + `INCR` via `ioredis` directly if `cache-manager` lacks `INCR`; key `idempotency:duplicate:skipped:<type>` `EX 86400` (or Prometheus `Counter idempotency_duplicate_skipped_total{type="..."}` if exporter exists). `Logger.log duplicate eventId=abc skipped` remains.

**Rationale**: Log gives trace; counter gives dash-able metric (`Grafana` `rate(idempotency:duplicate:skipped:notification[5m])`) for operators to verify retry health without grep. `INCR EX 86400` on Redis is cheap, fail-open on `ECONNREFUSED` → `Logger.warn Redis fail-open for idempotency counter` but log still counts. Deferring to Phase 13 would lose observable signal for Phase 12 verification.

**Alternatives**:
- Log-only V1 — rejected: not dash-able, operator must `grep` logs.
- Counter-only — rejected: loses correlationId trace.
- Silent return — rejected: not observable.

**Implementation**: Inject `CACHE_MANAGER` (`@Inject(CACHE_MANAGER) private cache: Cache`) and use `await (this.cache.store as any).client?.incr(key)` fallback to `cache.set(key, (await cache.get(key) ?? 0)+1, 86400)` if `incr` unavailable; never `console.log`.

---

## D6 — `FOR UPDATE` Ordering `Reservation → sorted Inventories → Order`

**Decision**: Preserve Phase 3-4 deterministic ordering: `SELECT Reservation WHERE id=:id FOR UPDATE` first (idempotent guard), then `SELECT Inventory WHERE id IN (:sortedIds) FOR UPDATE ORDER BY id ASC`, then `SELECT Order WHERE id=:orderId FOR UPDATE` if `orderId` exists. Never `UPDATE Inventory` before `status` check.

**Rationale**: Avoids deadlock when two workers claim disjoint reservations sharing an inventory (sorted `Inventory` locks), keeps guard before `reservedAmount` mutation to guarantee single decrement, and `Order` last avoids holding `Order` lock while scanning `Inventory`.

**Alternatives**: `Inventory` first — rejected: would lock inventories even for already `EXPIRED` no-op.

---

## D7 — `SET NX` vs PG `NotificationLog eventId @Unique` Fallback

**Decision**: V1 deduplication is **Redis `SET NX` primary** (`notification:send:*` or `notification:processed:<eventId>` `EX 24h`), with **optional** PG `NotificationLog` `eventId @Unique @Index` as second guard (`INSERT` with `ON CONFLICT DO NOTHING` → `0` rows → skip). V1 may ship `NotificationLog` entity but not required for correctness; if not shipped, `SET NX 24h` is sufficient and `FLUSHDB` duplicate after `24h` is bounded and acceptable per spec Q3.

**Rationale**: Redis `SET NX` p95 <1ms vs `INSERT ... ON CONFLICT` requires PG write; combining gives `PG` authoritative fallback without making `SET NX` authoritative for inventory truth (constitution I). If `NotificationLog` not yet migrated, `SET NX 24h` alone still single `send` per retry window.

**Alternatives**: Pure PG `processed_event` — rejected: heavier per-notification write.
Pure Redis — accepted as V1 if `NotificationLog` deferred.

---

## D8 — No `Idempotency-Key` Header (State-Based Guard)

**Decision**: Do **not** require client-supplied `Idempotency-Key` header for `POST /reservations/:id/expire`/`cancel`/`complete` or `POST /order/checkout`. Idempotency is **state-based** (`Reservation.status`, `Order.status`, `OutboxEvent.id`) + `eventId`/`SET NX`, while `X-Request-Id`/`X-Correlation-Id` → `payload.correlationId` is tracing only.

**Rationale**: Keeps contract simple (`supertest` retry without header remains idempotent), aligns with `Reservation` lifecycle already `RESERVED→*` one-way, avoids needing `IdempotencyKey` table with TTL. Header dedup would add `PG` table `idempotency_key` and complicate `FOR UPDATE` path.

**Alternatives**: `Idempotency-Key` table `idempotency_keys(key, response, expiresAt)` — rejected: extra migration, not needed for P0 `stock` invariant.

---

## Summary

All 5 spec clarifications (Q1-Q5) plus D6-D8 are now decisions with no `NEEDS CLARIFICATION` remaining. Ready for `data-model.md` + `contracts` + `quickstart`.

