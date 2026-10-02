# Refactoring Plan — Mini E-Commerce Backend (Spec-by-Spec, Rev. 2)

**Date:** 2026-10-02 (rev. 2 — R/B/S split, Phase 0 baseline, CC-A/B/C split, tx-ownership rule, invariants, gates) | **Mode:** planning only — no production code changed.
**Scope:** `specs/001`–`specs/014`, `src/`, `test/`.
**Supersedes:** Rev. 1 (same file). All project-specific findings, evidence, and module analysis from Rev. 1 are preserved; what changed is listed in the summary at the end.
**Governing rules:** no new features, no public API / event / queue / schema changes unless explicitly classified **B/S** with approval; no removed security checks; no redundant-query removal without proof; no silent `@Optional()` → required conversions.

---

## 1. Executive Summary

The codebase is functionally complete (specs 001–008, 010–014 DONE) but grew spec-by-spec without cross-spec consolidation. Four audits (auth; reservation; order/inventory/cart/products; outbox/notifications/infra) converge on one finding: **domain services own infrastructure** (Redis `SET NX`/`INCR` via `cache.store.client` sniffing, `ClientProxy.emit`, `DataSource` service-location, inline `crypto`/`Date`), **transaction ownership is inconsistent** (service-owns in `order-checkout.service.ts:54` vs controller-owns in `order.controller.ts:152,249` and `reservation.controller.ts:49,91,126,150`), **one class per hot path is oversized and multi-responsibility** (`AuthService` ~1267 lines, `refresh` ~170 lines, `NotificationsWorker` 1229 lines, `OutboxPublisher` 406 lines, `checkout` ~223 lines, `complete` ~230 lines, `transitionWithInventoryInternal` ~189 lines), and **the same idioms are copy-pasted** (sha256 ~14×, `FOR UPDATE` sorted-lock ~6×, `23514→409` ~3 variants, `assertOwner` ~4×, state-machine ~3×, pagination ~4×, dedup `SET NX` ~3×, retry `base·2ⁿ` ~3×, TTL parsing ~3×, correlation-id ~3×, quantity guard ~7×).

Rev. 2 corrects Rev. 1's risks: (a) **Phase 0** isolates the one correctness bug + two security-relevant inconsistencies + missing characterization baselines so no abstraction is built on a broken foundation; (b) the monolithic **CC-0 is split into CC-A (pure, safe) / CC-B (app policies, Rule-of-Three-gated) / CC-C (stateful/protocol, needs care)**; (c) every item is classified **R (behavior-preserving) / B (bug fix) / S (security fix)**; (d) **transaction ownership is fixed by rule** (use-case service owns the boundary; stores never commit/rollback); (e) query budgets are demoted to signals; line-counts to review signals; dead-code removal and `@Optional()`→required conversions are gated as behavior-affecting; (f) **auth moves before order/expiration controller work** because those phases edit `@Auth()`-guarded controllers and consume the `AuthenticatedUser` shape.

Target (unchanged):

```text
Controller (thin: authN/Z, DTO, tx-free) → Use-case Service (owns tx boundary)
  → Intent-based Stores (tx-scoped EntityManager in, never commit/rollback) → Entity
  → Ports (CC-A: Clock, IdGenerator, TokenHasher; CC-C: EventBus, IdempotencyStore,
           RetryPolicy, SchedulerLock) → Adapters (Redis, RMQ, SMTP…)
```

---

## 2. Current Architecture

Verified from code (not filenames):

```text
001-inventory-foundation (Inventory entity + InventoryService + seeder)
  ↓ 002-reservation-domain (Reservation/Item entities + ReservationService/Controller)
  ↓ 003-transaction-safe-reservation (FOR UPDATE + sorted locking in create)
  ↓ 004-reservation-lifecycle (transitionWithInventoryInternal + builder)
  ↓ 006-reservation-expiration-cleanup (ExpirationService + BullMQ Processor + REDIS_CLIENT)
  ↓ 007-order-integration (checkout: Order/OrderItem + createForCheckout + clearCart)
  ↓ 008-order-completion-sale (OrderCompletionService + cancellation service)
  ↓ 011-async-events-notifications (Outbox entity/service/publisher + consumer)
  ↓ 012-reliability-idempotency (idempotent guards + SET NX + requeue)
  ↓ 014-email-service (verification tokens + dispatcher/factory/channels + worker + gateway + history)

Orthogonal tracks:
  005-auth-upgrades ──→ 013-refresh-token ──→ 014 (verify/reset emails, emailVerified branch in refresh)
  009-redis-caching (products cache-aside) ──→ 010-rate-limiting (RateLimitGuard shared via AuthModule)
  users (no spec dir; owned by 005) ← auth, order, notifications import User entity directly (violation)
```

**Module boundary status (preserved from Rev. 1).** `CartService` is the good example (uses `ProductsService` + `InventoryService`, never raw repos). Violators: `OrderCheckoutService` imports `Inventory`/`Product` entities + `manager.find` (`order-checkout.service.ts:14-15,93-95,129-132`); `OrderCompletion/CancellationService` + `OrderService` touch `Reservation`/`Inventory` repos directly; `AuthService` touches `User` via `manager.getRepository(User)` (~8 sites) bypassing `UsersService`; `NotificationService.sendSalesCampaign` touches `Product` repo (`notification.service.ts:60-72`); `NotificationsWorker`/bulk touch `User`/`OutboxEvent` repos; controllers (`OutboxController`, `NotificationsController`, `OrderController` tx blocks, `ReservationController` tx blocks) own `DataSource`; `ReservationService` exposes `public readonly dataSource` (`reservation.service.ts:48`).

**Transaction-ownership violations (assigned to phases in §7):** controller-owns-tx in `reservation.controller.ts:49,91,126,150`, `order.controller.ts:152-160,249-258`; service-owns-tx in `order-checkout.service.ts:54`, `products.service.ts:524`. Rule (§10, TI-3): all use-case services own their boundary; controllers become tx-free.

---

## 3. Refactoring Principles

**SOLID** — SRP (split at tx/orchestration/persistence/transport seams, justified per-phase); OCP (abstract only real extension points: notification channels ✓ exists, email providers ✓ exists, transports/queue backends, retry policies); LSP (Noop providers must honor contracts — legacy `worker.sendBulk` hardcodes `provider:'noop'` + fake `@example.com` emails → delete, don't fix); ISP (split `NotificationsWorker`'s ~12-job surface; `RateLimitGuard.getLimitsForRoute` ~200 lines into a policy table); DIP (depend on ports only where §7's Rule-of-Three table justifies: `Clock`, `IdGenerator`, `TokenHasher`, `EventBusPort`, `IdempotencyStore`, `RetryPolicy`, `ProductCachePolicy`, intent-based stores).

**DRY** — Rule of Three enforced per abstraction (§7 CC-A/B/C tables answer the six gate questions). Only ≥3-site responsibilities qualify (token-hash, sorted-lock, 23514-map, assertOwner, pagination, dedup-keys, retry-math, TTL-parse, correlation-id, quantity-guard, outbox-emit). Two-site similarities (purge-tokens ×2, bulk-revoke ×2, `strateges/` typo) are merge-if-touching, never standalone phases. State-machine/ownership helpers are **per-domain** (order vs reservation tables differ) unless Phase 7 proves one shared responsibility — no generic `StateMachine<T>`, `RepositoryBase<T>`, `ServiceBase`, or CRUD abstractions (§10 MF-1).

**Clean Code (signals, not laws)** — oversized functions (`refresh` ~170, `transition…` ~189, `processExpiredBatch` ~207, checkout/complete ~230, worker 1229-file) and deep nesting are **review signals** pointing at multiple responsibilities, never extraction justification alone. Named constants for TTLs/magic values; no new `any` without justification; accurate JSDoc per AGENTS.md §3.

**Architecture** — Controller → Use-case (owns tx) → Intent-based Store → Entity; controllers never touch `DataSource`/repos; services never touch `ClientProxy`/`Queue`/`cache.store.client`; cross-module via exported services only; `EMAIL_PROVIDER` factory in exactly one module.

**Testing** — characterization tests before each split; **query counts are performance signals/investigation triggers, not correctness invariants** (§10 PQ-1); deterministic `Clock`/`IdGenerator` fakes; mock ports not framework internals; real-PG `Promise.all` single-winner concurrency tests stay green.

**Persistence** — intent-based stores (`lockInventoriesSorted`, `acquireRefreshToken`, `claimOutboxBatch`, `markOutboxSent/Failed`, `acquireSchedulerTick`); short tx; DB-authoritative security state; guarded updates kept; deterministic lock order.

**Concurrency** — ownership/lease/token checks kept; atomic updates; explicit tx boundaries; idempotency byte-for-byte.

**Messaging** — transport abstraction, retry-policy separation, idempotent consumers, at-least-once documented, scheduler re-entrancy kept, graceful shutdown kept.

**Configuration** — typed config objects parsed once at startup; no `process.env` in business logic; no silent `?? 'secret'/'test'/'localhost'` fallbacks in new code.

**Observability / Docs** — structured helpers, hashed-token-prefix logging only, correlationId threaded once; Swagger annotations move untouched.

---

## 4. Architectural Invariants

Checked after every relevant phase (see Refactoring Gates, §7 per-phase):

- **TI-1 Module boundaries.** Controllers do not access repositories/`DataSource`/`EntityManager`. One module never `@InjectRepository`/imports another module's entity for writes — cross-module behavior goes through the owning module's public service. (`CartService` is the conforming example.)
- **TI-2 Inventory ownership.** Only the Inventory boundary mutates `stock`/`reservedAmount` (`InventoryStore.lockInventoriesSorted` + delta appliers). `available = stock − reservedAmount` is derived, never stored.
- **TI-3 Transaction ownership.** Use-case/application services own the tx boundary (`dataSource.transaction` inside the service). Stores receive a tx-scoped `EntityManager` and never commit/rollback. One business operation touching multiple authoritative resources uses one tx. Controllers are tx-free.
- **TI-4 Outbox atomicity.** Every `OutboxEvent` row is created in the same tx as its authoritative state change, via the same `EntityManager`. No `client.emit` inside a tx.
- **TI-5 PostgreSQL truth.** PostgreSQL is authoritative for users/products/cart/inventory/reservations/orders/tokens/outbox. Redis holds cache/dedup/rate-limit/poison state only — never availability, ownership, or revocation decisions.
- **TI-6 Locking discipline.** Multi-row inventory locks are acquired in deterministic sorted order inside the owning tx. Last-unit races have exactly one winner (`Promise.all` proof).
- **TI-7 Idempotency/lease semantics.** Same-transition replays return the documented idempotent success with zero delta; `processingToken`/lease checks stay atomic (`WHERE … AND token=:token`); dedup keys/counters keep their names/TTLs unless a B-phase explicitly changes them.
- **TI-8 Auth security model.** Raw tokens never stored/logged (sha256 hashes only); refresh rotation stays single-use with theft revoke-all; `tokenVersion` remains the global nuke; token/refresh rows are read `FOR UPDATE` where the current code locks them.

---

## 5. Refactoring Classification

- **R — Refactor.** Behavior must remain equivalent (status codes, bodies, headers, cookies, event payloads, queue names, retry counts/TTLs, SQL semantics). Split/extract/rename internals only. Verified by the Behavioral Gate (§7 per phase).
- **B — Bug Fix.** Intentionally changes incorrect behavior. Must name the bug, the current wrong behavior, and the corrected behavior, with a regression test. (This plan contains exactly one: **B-1** outbox-cleanup SQL.)
- **S — Security Fix.** Intentionally changes security behavior. Must name the weakness and the intended semantics, with tests. (This plan contains **S-1** dual-JWT-guard unification scope and **S-2** `validateResetToken` TOCTOU decision; both are *decision-gated* — characterized in Phase 0, enacted only with human approval.)

A phase may carry multiple labels; each item below is tagged `[R]`, `[B]`, or `[S]`.

---

## 6. Phase 0 — Correctness / Characterization Baseline

**Goal:** stabilize the foundation (one B, two S-decisions, baselines) before any abstraction is built on top.

| ID | Class | Item | Evidence | Action in Phase 0 | Regression proof |
|----|-------|------|----------|-------------------|------------------|
| P0-1 | **[B]** | Outbox cleanup deletes nothing | `outbox-cleanup.service.ts:33-36`: `…(status=$1 …) OR (status=$2 …)` with params `[SENT, retentionDays]` — `$2` is both a status and a day-count; `FAILED` never matches; `SENT_TO_MQ/CONSUMED/DELIVERED` never match | Fix placeholders + status list in an isolated commit; no other change | Retention test: seed old `SENT_TO_MQ`/`FAILED`/fresh rows → `cleanup()` deletes only expired terminal rows |
| P0-2 | **[S-decision]** | Dual JWT paths diverge | `guards/jwt.guard.ts:14-32` manual `verifyAsync`, no `tokenVersion` check vs `strateges/jwt.strategy.ts:30-36` with check; `auth.decorator.ts:7-11` hardcodes `JwtGuard`; `auth.controller.ts:297-298` stacks both | **Characterize only**: lock both paths' tests (revoked-user 401 matrix). Unification itself is RP-AUTH (S-1), needs human approval of chosen path | Tests proving current divergence, pinned |
| P0-3 | **[S-decision]** | `validateResetToken` unlocked read vs locked `resetPassword` (TOCTOU) | `auth.service.ts:553-568` plain `findOne` vs `:587-594` `FOR UPDATE` | **Characterize only**: concurrent validate+reset test documenting current window. Fix (lock or recheck) is RP-AUTH (S-2), needs approval | Concurrency characterization test |
| P0-4 | **[R]** | WS gateway `tokenVersion` gap (self-noted) | `notifications.gateway.ts:64` comment; `handleConnection:35-56` with `WS_AUTH` bypass | Characterize: test revoked-user WS connect outcome; document. Fix rides RP-NOTIF with auth-track decision (risk R-4) | Pinned behavior test |
| P0-5 | **[R]** | Characterization baselines for all hot flows | `refresh` rotation/theft, checkout totals/snapshots, complete idempotency, verify/resend, outbox claim/publish/retry, bulk gate/dedup-replay | Add/confirm characterization + real-PG `Promise.all` single-winner suites per flow; record current query shapes as **signals** (not budgets) | Suites green on unmodified code |

**Why Phase 0 exists:** P0-1's broken retention silently grows `outbox_event`; P0-2/P0-3 are security-relevant semantics that every later auth/outbox abstraction inherits. Fixing/characterizing them first prevents building ports on top of undefined behavior.
**Dependencies:** none. **Affected modules:** outbox, auth, notifications (gateway). **Risk: Low** (P0-1 isolated) / **Blast radius: Low**. **DoD:** P0-1 merged separately; P0-2–P0-4 pinned tests; P0-5 baselines green.
**Gates:** Behavioral (B fix documented + test); Verification (`lint/build/test/test:e2e` relevant suites).

---

## 7. Refactoring Phases

Per-phase fields: Classification · Goal · Why This Phase Exists · Current Problems · Evidence · Target · SOLID/DRY/Clean · DB/Persistence · Tx Ownership · Concurrency · Testing · Config/Infra · Dependencies · Affected · Risk/Blast Radius · DoD · Gates. (Only applicable sub-fields are shown; all phases carry Risk + Blast Radius + Affected + Gates.)

**Conventions used below.** "Store" = intent-based persistence boundary receiving a tx-scoped `EntityManager`, never committing. "Port/Adapter" only where the Rule-of-Three table justifies. Size mentions (≈N lines) are review signals, not extraction mandates. Query observations are signals per §10 PQ-1. Dead-code items cite reachability evidence per §10 DC-1. `@Optional()` changes are flagged behavior-affecting per §10 OD-1.

---

### CC-A — Pure low-risk primitives `[R]`

- **Goal:** deterministic, dependency-free primitives with obvious ownership.
- **Why:** `new Date()` (~30× auth), inline `crypto`, and triple TTL parsing are the most-copied, least-risky seams; every later phase consumes them.
- **Problems/Evidence:** `crypto.randomBytes(32).toString('hex')` ×7 + `sha256` ×14 (`auth.service.ts:157-158,201-204,237-240,347-348,410-413,501-506,556-559,580-583,712-713,741-744,784-787,874-875,951,1010-1011`); TTL parsers ×3 (`parseTtlMs:1221-1232` vs `parseTtlWithDefault:666-679` vs controller `getRefreshCookieOptions:58-75`); `new Date()/Date.now()` ~30×.
- **Rule-of-Three gate:** (1) responsibility: wall-clock read / CSPRNG token / one-way hash / duration parse; (2) sites above (≥7); (3) consumers: all token phases + expiration + outbox; (4) coupling removed: business logic ↔ `node:crypto`/`Date`/stringly TTLs → fakes in tests; (5) complexity added: 3 tiny injectables + 1 function; (6) duplication now costs: 3 divergent TTL semantics + untestable time. **Pass.**
- **Target:** `Clock` (`now()`, `plusMs()`), `IdGenerator` (`randomUUID()`), `TokenHasher.sha256Hex()`, `SecureToken.generateHex(32)`, single `parseDurationMs()` (one semantic, startup-validated typed configs in CC-A: `AuthTokenConfig`, `ExpirationConfig`, `OutboxConfig`, `RateLimitConfig`, `EmailConfig` — parse-once via `ConfigService`, replacing 8× clamp blocks e.g. `outbox.publisher.ts:51-54,88-115`).
- **SOLID:** DIP (depend on ports); SRP (time/randomness/hash/config leave domain). **DRY:** hash/random/TTL/clamp unified. **DB/Tx/Concurrency:** none (pure). **Testing:** deterministic fakes; characterization unchanged.
- **Dependencies:** Phase 0. **Affected modules:** shared (`src/common/`); **Flows:** all token/TTL flows (no behavior change — same defaults). **Risk: Low · Blast radius: Low** (mechanical substitution, same outputs).
- **DoD:** all call sites use ports; no `crypto`/`new Date` in touched business logic; configs typed + clamped once; tests green.
- **Gates:** Behavioral (identical hashes/TTLs); Architectural (ports own no business logic); Verification (unit + `build/lint`).

### CC-B — Shared application policies `[R]`

- **Goal:** unify repeated *application-level* responsibilities behind intention-revealing helpers (not a framework).
- **Why:** the same 6 policies recur across reservation+order+controllers; each is a proven shared responsibility, and unifying first lets RP-* phases consume rather than re-invent them.
- **Problems/Evidence + Rule-of-Three verdicts:**
  - `assertPositiveInt(q)` — quantity guard ×7 (`cart.service.ts:92,262,306`, `inventory.service.ts:72,82,93,149,170,188`, `order-checkout.service.ts:68`) with 3 message variants. **Pass** (7 sites, one rule).
  - `mapInventoryCheckError` (`23514`/CHK→409) — ×3 variants (`order-checkout:162-170`, `order-completion:296-307`, `reservation:628-641` + swallow-variant `:666-675` unified to one semantic). **Pass.**
  - `assertOwnerOrAdmin(entityUserId, reqUser)` — ×4 identical (`order.service:161-165`, `order-completion:115-120`, `order-cancellation:57-65`, `reservation:695-705`). **Pass** — per-domain call, one shared predicate (not a generic guard framework).
  - `paginate()` + `buildMeta()` + `PAGE_MAX` — ×4 envelopes (`order.service:72,92-101`, `products:404,412-421`, `outbox.controller:62-87`, `notifications.controller:148-173`). **Pass.**
  - Per-domain transition tables (order vs reservation `ALLOWED_*` ×3 + `validate*` ×3) — **kept per-domain** (rejected generic `StateMachine<T>`; the two tables are different responsibilities that change for different business reasons).
  - `OrderResponseMapper` (dual `unit_price`/`subtotal` keys ×2, `order.controller:72-91` vs `:162-188`) — **Pass** (contract-preserving mapper, byte-identical output).
  - `correlationId()` (headers `x-request-id|x-correlation-id` → `randomUUID()` ×3, `order.controller:64-67,148-151,242-245`) + `resolveRefreshRaw` (body→cookie→header, controller `:77-96` vs guard `:257-260`) — **Pass** (2–3 sites each, one HTTP-boundary responsibility; guard/service share one helper).
- **Target:** `src/common/` (or per-domain co-located) helpers above; no `BaseRepository`/`ServiceBase`/generic state machine (§10 MF-1).
- **Tx/Concurrency/DB:** none (pure functions). **Testing:** unit matrix per helper + unchanged controller suites.
- **Dependencies:** CC-A (uses `IdGenerator` for correlation fallback). **Affected:** reservation, order, inventory, cart, products, outbox, notifications controllers/services. **Risk: Low · Blast radius: Low.**
- **DoD:** helpers used at all cited sites; messages/keys byte-identical; tests green. **Gates:** Behavioral; Maintainability (Rule of Three documented per helper).

### CC-C — Stateful / protocol-sensitive infrastructure `[R]` (design now, land with RP-OUTBOX)

- **Goal:** isolate retry/lease/envelope/dedup/transport semantics behind ports — designed once, implemented alongside the outbox split that exercises them.
- **Why:** these affect persistence, leases, retries, and wire contracts; grouping them with pure utilities (Rev. 1 CC-0) understated the risk. Evidence: dedup `SET NX` ×3 + counters ×2 with ms/s TTL mixing (`worker:60-124`, `consumer:35-90`, `bulk:80-94`); envelope encode ×1/decode ×3 divergent (`outbox.service:49-56` vs `worker:208-268` vs `consumer:103-137`); retry `min(max,base·2ⁿ⁻¹)` ×3 (`publisher:123-130`, `worker:468`, `bulk:358`); claim+publish coupled to `ClientProxy` (`publisher:34-36,253-388`); `SchedulerLock` (`expiration:tick:lock`, `processor:52-58`) + poison keys.
- **Rule-of-Three verdicts:** `IdempotencyStore.tryAcquire/incr` (**Pass**, ≥5 key families); `RetryPolicy.next()` (**Pass**, 3 backoff sites + 2 enqueue sites); `EnvelopeCodec.encode/decode` (**Pass**, 1 encode + 3 decodes of one contract); `EventBusPort.emit` / `OutboxTransport` (**Pass**: publisher's only reason to change transport); `BulkEnqueuePort` (**Pass**: `notification.service:28,78-79,89-90,112-114` queue+job+backoff inline); `SchedulerLock.acquireTick` + `PoisonTracker` (**Pass**: tick-lock + poison `INCR/EXPIRE` currently copy-pasted `reservation.service:76-108` vs `expiration.service:137-161`). `emitOutboxBestEffort(manager, evt)` (**Pass**, ×3 outbox try/catch-warn sites).
- **Target:** ports + Redis/RMQ adapters; `OutboxConfig` lease/retry/retention already typed in CC-A. SchedulerLock keeps current key/TTL (`expiration:tick:lock`, `ttlSec+5` semantics preserved as constants).
- **Tx ownership:** ports never own tx; `claimOutboxBatch(manager)` receives the tx-scoped context; commit stays in the use-case. **Concurrency:** lease/token checks unchanged (TI-7). **Testing:** port fakes; real-Redis single-winner + lease-reclaim proofs stay.
- **Dependencies:** CC-A (+CC-B `paginate` for requeue listing). Implemented/tested inside RP-OUTBOX; design reviewed before RP-EXP/RP-ORDER touch poison/emit paths. **Affected:** outbox, notifications, reservation-expiration. **Risk: Medium · Blast radius: Medium** (lease/retry semantics). **DoD:** adapters swapped without caller change; duplicate-`eventId` harmless; `EXPLAIN` uses composite index.
- **Gates:** Architectural (no `ClientProxy`/`Queue`/`store.client` in callers); Persistence/Concurrency (lease atomicity, at-least-once documented); Behavioral (keys/TTLs/counts identical).

### RP-INV — Inventory foundation (spec 001) `[R]`

- **Why:** restores the "single mutation point" invariant (TI-2) and removes verified-dead code before the lock helper (CC-B/CC-C consumers) is built on this module.
- **Problems/Evidence:** `InventoryController.checkAvailability:48-61` reimplements `available >= quantity` instead of calling the service; `checkAvailabilityMany/increaseStockLegacy` `never`-stubs (`inventory.service.ts:212-219`) — reachability: no static import, no provider/route/queue/test reference (grep §App; re-verify at implementation); unused `ProductsService` dep + `forwardRef` cycle (`inventory.service:21-23` vs `products.service:38-39` — constructor param never read); message variants; `ParseUUIDPipe` on FK `productId`.
- **Target:** thin controller (delegates); stubs removed; dead dep + cycle removed (records the `forwardRef` removal); `AvailabilityQueryDto` moved to `dto/`; no behavior change (`ParseUUIDPipe` semantics pinned by test before any adjustment — changing validation is `[B]`-gated, not done silently).
- **SOLID:** SRP. **DRY:** CC-B `assertPositiveInt` + getter `available`. **DB:** unchanged (checks stay). **Tx:** reads stay tx-free. **Testing:** 200/400/404/409 characterization.
- **Dependencies:** CC-A + CC-B. **Affected modules:** inventory. **Tables:** `Inventory`. **Risk: Low · Blast radius: Low.** **DoD:** stubs/dep gone, delegation verified, tests green. **Gates:** Behavioral + Dead-code reachability evidence + Verification.

### RP-CACHE-GUARD — Products cache + rate-limit guard (specs 009+010) `[R]`

- **Why:** two self-contained, low-risk extractions that prove the port pattern and unblock nothing else — ideal early wins.
- **Problems/Evidence:** `ProductsService` mixes catalog + cache-aside + TTL-parse + 3 invalidators + `NotificationService.onProductCreated:274-280`; `CACHE_MANAGER get/set/del/clear` interleaved (`:125,201,387,425,444,468,600,609`); O(n²) `find(name)/find(id)` (`:352-368`, `:543-550`) — note: index-by-map is an internal perf change, query shapes unchanged; `RateLimitGuard.getLimitsForRoute:225-423` ~200 lines; controller TTL-parse 3rd copy; `InventoryController.increase/decrease` unguarded (`inventory.controller:63,84` — decision: guard or document exemption, no silent change).
- **Target:** `ProductCachePolicy` adapter (keys/TTLs/invalidation; post-commit invalidation preserved); table-driven `RateLimitPolicies`; shared body/cookie extraction (CC-B).
- **Tx/DB:** cache never inside tx (post-commit preserved); query-count observations are signals (PQ-1). **Testing:** hit/miss/invalidation + 429-header matrix.
- **Dependencies:** CC-A + CC-B. **Affected:** products, auth (guard), inventory (decision only). **Infra:** Redis (cache/limiter, non-authoritative). **Risk: Low · Blast radius: Low.** **DoD:** matrices green; exemption decision recorded. **Gates:** Behavioral (headers/keys/TTLs identical) + Verification.

### RP-RES — Reservation domain + tx-safe create (specs 002+003) `[R]`

- **Why:** fixes the load-bearing Law-of-Demeter break (controllers reaching through `public dataSource`) and creates the single locking primitive everything downstream reuses.
- **Problems/Evidence:** controller-owns-tx ×4 (`reservation.controller:49,91,126,150` via `reservation.service:48`); lock duplication create-vs-transition; `available` 3 ways; dead `transition` alias (`:445-461`, single forwarder — reachability: only internal callers, re-verify); pagination inline (`listByUser:324-359`); `(manager as any).__orderBeforeStatus` hack (`expiration.service:286-309` — replace with explicit tx-scoped local/return).
- **Target:** use-case methods own tx (`createTx/completeTx/cancelTx/expireTx…`); internal `manager`-overloads kept for composition (expiration/order call the overloads **inside their own single tx** — never nested-service-tx); `lockInventoriesSorted(manager,ids)` intent-based store; CC-B `paginate()`; `dataSource` no longer `public`.
- **Tx ownership:** the phase's core: boundary moves controller→service per TI-3; multi-store participation via shared `EntityManager`. **Concurrency:** sorted order + `available` check preserved; `Promise.all` race suites mandatory. **DB:** no schema change.
- **Dependencies:** CC-A + CC-B. **Affected modules:** reservation. **Flows:** create/read/complete/cancel/expire. **Tables:** `reservation`, `reservation_item`, `Inventory` (locked). **Risk: Low-Med · Blast radius: Medium** (tx move). **DoD:** controllers tx-free; single lock path; races green. **Gates:** Behavioral + Architectural (TI-1/TI-3) + Persistence/Concurrency + Verification (incl. concurrency tests).

### RP-LIFECYCLE — Reservation lifecycle split (spec 004) `[R]`

- **Why:** the 189-line `transitionWithInventoryInternal:498-686` performs 7 jobs (lock→owner→idempotency→validate→orderId→order-cancel→lock-inv→mutate→cancel→reload); unauditable as one unit. Size is a signal; the 7 responsibilities are the justification.
- **Problems/Evidence:** as above + `23514→409` variant (`:628-641` vs expiration `:169-190` vs swallow `:666-675`); Order auto-cancel ×2 (`:577-581` vs `:655-658`); builder (`reservation-transition.builder.ts:14-80`) used once (`service:439-442`), 4 fluent methods never called, breaks encapsulation (`(service as any):70-78`).
- **Target:** `ReservationTransitionService`: `loadAndLock → checkIdempotency → applyInventoryDelta → persistAndLink`; builder deleted (single call-site inlined; Rule of Three: promote only if a 2nd caller appears); CC-B error-map; auto-cancel paths unified.
- **Tx:** steps share the use-case's tx-scoped manager; no nested commits. **Concurrency:** Reservation-first then sorted-inventories order preserved (TI-6). **Testing:** 200/409 matrix + single-winner races.
- **Dependencies:** RP-RES. **Affected:** reservation (+ order link rows read/updated in same tx). **Tables:** `reservation`, `reservation_item`, `Inventory`, `Order`. **Risk: Medium · Blast radius: Medium.** **DoD:** steps independently reviewable; matrix + races green. **Gates:** all five.

### RP-AUTH — Auth upgrades + refresh token (specs 005+013) `[R + S-1 + S-2 gated]`

- **Why:** the god service (1267 lines; `refresh:225-394` nesting 5) couples orchestration + persistence + broker + cache + HTTP; every request flows through it; order/expiration controller work (RP-ORDER/RP-EXP) needs its stabilized `AuthenticatedUser`/guard semantics first.
- **Problems/Evidence `[R]`:** `resendVerification:832-916` builds HTTP 429 in service; `emitAuthEvent:630-657` broker inside domain; cache keys/TTLs inline (`:837,900,941-969,1015-1060`); `manager.getRepository(User)` ×8 bypassing `UsersService` (TI-1); TTL parsers ×3; cap-5 LRU ×2 (`:165-183` vs `:330-345` — merge-if-touching); bulk-revoke ×2 (`:276-283` vs `:445-450`); anti-enum+invalidate-priors ×3; `any` pervasive; `strateges/` typo dir; `console.log` (`auth.controller:124,126`); `LocalAuthGuard:15-27` duplicates global pipe; `register:67-94` returns `data:newUser` (confirm no password leak — pinned by test; any change is `[S]`-gated).
- **Problems `[S-1/S-2]` (decision-gated, Phase-0-characterized):** S-1 dual JWT guards (unify to `JwtStrategy` as sole path — or delegate; both paths' tests locked first); S-2 `validateResetToken` TOCTOU (add lock or documented read-only-with-recheck). Enact only with human approval.
- **Target:** `AuthService` (orchestration) + intent-based stores (`RefreshTokenStore.acquire/rotate/revoke`, `VerificationTokenStore`, `OtpStore`) + `AuthEventPublisher` (CC-C `EventBusPort`) + CC-A `TokenHasher/Clock`; `UsersService` owns all `User` writes; OTP paths stay 501-isolated (only shared stores reused).
- **Tx:** stores take tx-scoped manager; rotation/theft-nuke stays one tx (TI-3). **Concurrency:** `FOR UPDATE` + single-use + cap-5 + theft-nuke preserved; concurrent-refresh single-winner re-proof. **Config:** CC-A typed `AuthTokenConfig`; silent `?? 'secret'/'test'` fallbacks centralized with warn-once (changing to hard-fail is `[B]`-gated, decided in phase, not silent).
- **Dependencies:** Phase 0 (P0-2/P0-3 pinned) + CC-A + CC-B. **Affected modules:** auth, users. **Flows:** register/login/refresh/logout/logout-all/forgot/reset/verify/resend/Google/OTP-501. **Tables:** `user`, `refresh_token`, `password_reset_token`, `email_verification_token`, `otp_verification`. **Infra:** Redis (cooldown/rate/counters — fail-open preserved), RMQ (auth events). **Risk: High · Blast radius: High.**
- **DoD:** identical status/body/cookie/header matrix; theft/logoutAll green; no HTTP-in-service; no `any` without justification. **Gates:** Behavioral (+ explicit S-change docs if S-1/S-2 approved) + Architectural (TI-1/TI-3/TI-8) + Persistence/Concurrency + Verification.

### RP-ORDER — Checkout + completion/cancel (specs 007+008) `[R]`

- **Why:** the two largest business flows (223-line checkout with 13 steps; 230-line complete with double-`findOne` under lock) duplicate ownership/transition/outbox/correlation logic and straddle two tx conventions.
- **Problems/Evidence:** `order-checkout.service:50-273` (13 steps); `order-completion.service:134-363` (double `findOne:144-157`, double reservation load `:192-205` — collapse only after proving redundancy, PQ-1); `validateOrderTransition`+`assertOwner` ×3–4; `ALLOWED_*` ×3 (kept per-domain; shared predicate from CC-B, not generic machine); response shaping ×2 (`order.controller:72-91` vs `:162-188` → CC-B mapper); outbox try/catch ×3 (→ CC-C `emitOutboxBestEffort`); correlation ×3 (→ CC-B); `currency:'usd':235` → config constant (same value); N+1 `Promise.all(findOne Reservation)` (`order.service:79-90` — join/projection only with signal evidence); `clearCartForCheckout` manager-variant vs `void deleteCartItemsInBackground:365` (unify semantics, pinned by test).
- **Target:** `CheckoutUseCase: loadCart → lockReserve → createGraph → emitOutbox`; `CompletionUseCase: loadAndLock → idempotency → mutate → emit`; all inside service-owned single tx with Inventory/Reservation/Outbox stores participating via shared manager (TI-3/TI-4); controllers tx-free (removes `order.controller:152,249` tx blocks).
- **Concurrency:** sorted locks, guarded updates, idempotent same-transition 200s preserved. **Testing:** totals/snapshots/409/403 matrix + historical-price + races.
- **Dependencies:** RP-RES + RP-LIFECYCLE (lock/transition seams) + RP-AUTH (`AuthenticatedUser`, owner checks) + CC-C (emit/keys). **Affected modules:** order, cart (clear path), reservation, inventory (locked), outbox (rows). **Tables:** `order`, `order_item`, `cart`, `reservation`, `Inventory`, `outbox_event`. **Events:** `order.created/completed/cancelled` (payloads unchanged). **Risk: Medium · Blast radius: High** (core money flow). **DoD:** matrices + races green; controllers tx-free. **Gates:** all five.

### RP-EXP — Expiration cleanup (spec 006) `[R]` (+ OD-1 decision)

- **Why:** batch loop + poison + scheduling are tangled across two Redis clients with inconsistent config parsing; the worker reuses the lifecycle transition correctly (keep) but its surroundings need seams.
- **Problems/Evidence:** `processExpiredBatch:235-442` ~207 lines; dual Redis (`REDIS_CLIENT any` + `CACHE_MANAGER`, fallbacks copy-pasted `:76-108` vs `:137-161` → CC-C `IdempotencyStore`/`SchedulerLock`/`PoisonTracker`); `DEFAULT_TTL_MS:36` hardcoded → CC-A config; processor clamp inconsistency (`:44-47,77-85` vs service `:192-208`); `ttlSec+5` magic → named constant (same value); `clearPoisonState:471-495` bare `throw new Error()` → typed error (same catch semantics); `OutboxService @Optional:41-42` silent no-op → **[OD-1]**: making it required changes startup/failure behavior (currently expiration silently skips `order.cancelled` linkage when unwired); phase must state current-absent vs required-present behavior + wiring + startup test; fail-open removal only with approval.
- **Target:** `ExpirationScanner` + `PoisonTracker` + `SchedulerLock` ports; typed `ExpirationConfig`; required-vs-optional decision recorded with tests.
- **Tx:** per-candidate single tx reusing lifecycle overload (TI-3); scan stays outside tx (short locks). **Concurrency:** tick-lock + `FOR UPDATE` single-winner + quarantine preserved. **Testing:** 60s-SLA path, single-winner, quarantine.
- **Dependencies:** RP-LIFECYCLE + CC-C. **Affected:** reservation (expiration), outbox (conditional `order.cancelled` rows). **Infra:** BullMQ repeat-30s, Redis tick/poison. **Risk: Medium · Blast radius: Medium.** **DoD:** SLA path unchanged; decision OD-1 recorded + tested. **Gates:** all five (+ OD-1 evidence if deps made required).

### RP-OUTBOX — Outbox + idempotency (specs 011+012) `[R]` (lands CC-C)

- **Why:** the publisher (406 lines: poll+claim+publish+token-updates+retry+config+log-dedup) couples lease/retry/transport; dedup/envelope/retry are proven ×3-shared and CC-C's justification case.
- **Problems/Evidence:** `outbox.publisher.ts:25-406` (success/fail token-checked blocks near-duplicate `:275-312` vs `:331-368`); `NODE_ENV==='test'` via `process.env:45` → `ConfigService`; transport coupling (`:34-36,253-388`); envelope/dedup/retry ×3 (CC-C); queue/job names + `attempts 3/5` scattered → constants (same values); requeue/`GET` pagination → CC-B `paginate()`. (P0-1 cleanup-SQL already fixed in Phase 0.)
- **Target:** `OutboxClaimer` (`claimOutboxBatch` intent-store) + `OutboxTransport` (CC-C RMQ adapter) + CC-C `RetryPolicy` + typed `OutboxConfig`; CC-C `IdempotencyStore/KeyFactory/EnvelopeCodec` canonical.
- **Tx:** claim tx owns `FOR UPDATE SKIP LOCKED` + token write; publish loop outside tx; success/fail updates stay token-guarded (TI-7). **Concurrency:** lease-reclaim + late-writer protection preserved; `EXPLAIN` keeps composite index. **Testing:** claim/publish/retry/retention + concurrent-publisher disjointness + duplicate-`eventId` harmless.
- **Dependencies:** CC-C design + RP-ORDER (emit call sites) + Phase 0 (P0-1). **Affected:** outbox. **Tables:** `outbox_event`. **Queues:** `notification_queue` (names unchanged). **Risk: Medium · Blast radius: Medium.** **DoD:** semantics identical; index used; replays safe. **Gates:** all five.

### RP-NOTIF — Email/notifications (spec 014) `[R]` (largest surface)

- **Why:** the 1229-line worker owns ~12 responsibilities + 6 `@EventPattern`s + a dead legacy path; gateway mixes auth/rooms/emit/read-echo; history queries live in controllers. Last phase because it consumes CC-C + RP-AUTH + RP-OUTBOX seams.
- **Problems/Evidence:** `notifications.worker.ts:31-1229` (dedup `:60`, counter `:102`, log `:137`, envelope `:208`, uuid `:275`, channel-enum `:290`, ack `:302`, consumed `:318`, contact `:359`, deliveries `:405`, finalize `:443`, maybe-delivered `:508`, orchestrator `:534`, row-upsert `:649`, channel-send `:695`, legacy-email `:731`, patterns `:772-1006`, dead `sendBulk:1122-1228` with fake `@example.com:1171` + hardcoded `provider:'noop':1213` — reachability: public method, registered provider; callers: none besides tests? verify static imports + DI + routes + specs at implementation; `EventVerificationConsumer:17-360` placeholder alias superseded by `resolveUserContact`); gateway (`:19-108`: JWT verify + `WS_AUTH` bypass `:51-56` + `handleRead:108` duplicating `PATCH :id/read`); `sendSalesCampaign:41-72` Admin-gate + revalidation + `Product`-repo check (TI-1); `EMAIL_PROVIDER` factory ×2 (`email.provider.ts:82`, `notifications.module:51-64`, `auth.module:52-64`); `@Optional() dataSource/config` fail-opens (`worker:44-51`, `bulk:33-42`, `channels/*`, `notification.service:29`) — **[OD-1]**: each conversion needs current-absent vs required-present behavior + wiring + startup test; silent `?? 'localhost'/587/FRONTEND_URL/WS_AUTH/'noop'` defaults centralized (hard-fail only with approval); ms/s TTL mixing → constants (same values); log strings ×20 → helpers.
- **Target:** thin `NotificationConsumer` + `DeliveryStore` + `ContactResolver` + `NotificationHistoryService` (owns `notifications.controller:152,192,242` queries) + emit-only gateway (`WsJwtGuard`; `handleRead` removed only after proving HTTP parity — else kept); single `EmailModule` factory; R-4 WS-`tokenVersion` fix only with auth-track approval.
- **Tx:** worker's `FOR UPDATE OutboxEvent` + dedup + ACK ordering preserved; per-channel `PENDING→SENT→DELIVERED→FAILED` (3 attempts) unchanged. **Concurrency/Idempotency:** `SET NX` keys/TTLs + `@Unique(eventId,channel)` backstop unchanged. **Testing:** verify/resend/reset/sales/prefs/history/unread matrix; replay→0-new; offline-WS stays `SENT`.
- **Dependencies:** RP-AUTH (prefs/`emailVerified` branch, contact) + RP-OUTBOX (CC-C envelope/dedup/retry) + Phase 0 (P0-4 pinned). **Affected modules:** notifications, auth (factory move). **Tables:** `notification`, `notification_delivery`, `notification_log`. **Events/WS:** all `@EventPattern`s + `notification:new` (unchanged). **Infra:** RMQ, BullMQ `notification` queue, SMTP/Noop, WS. **Risk: High · Blast radius: Medium-High.** **DoD:** matrices green; legacy paths deleted with reachability evidence; factory single. **Gates:** all five (+ OD-1 evidence per converted dep).

---

## 8. Phase Dependency Graph

```text
Phase 0 (baseline: B-1 fix + S characterizations + baselines)
  ↓
CC-A (pure primitives + typed configs)
  ↓
CC-B (app policies) ──────────────────┐
  ↓                                    │
RP-INV ──┐                             │
RP-CACHE-GUARD ──┤ (independent)        │
  ↓              ↓                      │
RP-RES ──────────┴──→ RP-LIFECYCLE ────┤
                        ↓              │
                      RP-AUTH ◄────────┘ (AuthenticatedUser/guard semantics)
                        ↓
CC-C (stateful ports: design reviewed here, implemented in RP-OUTBOX)
  ↓
RP-ORDER ──┐ (needs AUTH + CC-C emit/keys + RES/LIFECYCLE seams)
RP-EXP ────┤ (needs LIFECYCLE + CC-C lock/poison; independent of ORDER)
  ↓        ↓
RP-OUTBOX (lands CC-C adapters; needs ORDER emit sites + P0-1)
  ↓
RP-NOTIF (needs AUTH + OUTBOX + P0-4)
```

No circular dependencies. `CC-C` design is reviewed before RP-ORDER/RP-EXP consume its ports; its adapters land in RP-OUTBOX.

---

## 9. Parallelization Opportunities

- After Phase 0: **CC-A** (single track, fast).
- After CC-B: **RP-INV ∥ RP-CACHE-GUARD** (disjoint files, no shared state).
- After RP-LIFECYCLE: **RP-AUTH** is a self-contained track (auth+users only; do not touch order/reservation files inside it).
- After CC-C design: **RP-ORDER ∥ RP-EXP** (different modules; both read-only consumers of shared ports; coordinate only on port signatures, frozen at CC-C review).
- Never parallelize: RP-OUTBOX with RP-NOTIF (consumer/producer of the same envelope/dedup contract); P0-1 with RP-OUTBOX (fix lands first); S-1/S-2 enactment with any dependent controller work (decide first).

---

## 10. Cross-Phase Architectural Rules

- **TX-1** Use-case services own `dataSource.transaction`; stores receive the tx-scoped `EntityManager` and never commit/rollback. Controllers are tx-free. (TI-3; violations listed in §2.)
- **TX-2** Cross-store composition shares one manager (`Order → Order/Inventory/Reservation/Outbox stores`), never nested `store.transaction()` calls.
- **ST-1** Stores are intent-based (`lockInventoriesSorted`, `acquireRefreshToken`, `claimOutboxBatch`, `markOutboxSent/Failed`, `acquireSchedulerTick`, `recordPoisonAttempt`). No `BaseRepository<T>`/`GenericStore`/`create/update/find/delete` wrappers (MF-1).
- **MF-1 (anti-framework)** No generic `StateMachine<T>`, `OwnershipHelper`, `RepositoryBase`, `ServiceBase`, CRUD/event abstractions. Transition tables stay per-domain. Every abstraction cites its Rule-of-Three row.
- **PQ-1 (query signals)** Query counts/latency/rows/index-use/lock-duration are investigation triggers. A flow may legitimately need N queries for N authoritative operations. Optimize only with request-flow evidence; never to hit a number.
- **DC-1 (dead code)** Deletion requires reachability evidence: static imports, DI providers, module registrations, routes, event/queue handlers, schedulers, dynamic refs, tests, config-driven behavior. Candidates: inventory stubs, `transition` alias, builder + unused fluent methods, `worker.sendBulk`, consumer alias, `users.service:65-72` block, `LocalAuthGuard` manual validation, `console.log`s, `(manager as any).__orderBeforeStatus` (replace, not just delete).
- **OD-1 (optional deps)** Converting `@Optional()` → required is behavior-affecting (startup/wiring/failure semantics). Each conversion states: why required; current absent-behavior; post-change behavior; providing modules; startup/wiring tests; whether fail-open is intentionally removed. Applies to: `NOTIFICATION_SERVICE` client, `OutboxService` in expiration, `CACHE_MANAGER` fallbacks, worker/bulk/channels `dataSource/config`, `RateLimitGuard` configService, gateway configService, SMTP config.
- **SG-1 (size signals)** Function/file/class size and nesting depth are review signals, not laws. Extract on responsibility boundaries, never on line counts alone.
- **CF-1 (config)** Typed objects parsed once at startup; no `process.env` in business logic (`data-source.ts`/`main.ts` entry + `NODE_ENV` branch → `ConfigService`); silent fallbacks centralized; hard-fail only with approval + tests.
- **SEC-1** Raw tokens/secrets/PII never logged/stored; hashes only. S-class changes need explicit approval + regression tests.

---

## 11. Final Definition of Done

1. `npm run lint`, `npm run build`, `npm run test`, `npm run test:e2e` green per phase (relevant suites + concurrency suites where touched).
2. R-phases: no public API / event / queue / schema delta (diff-reviewed against contracts + migration list); B/S-phases: intentional change documented + regression tests.
3. Characterization tests pre-split; real-PG `Promise.all` single-winner proofs where locking/idempotency touched; query observations recorded as signals with evidence.
4. No new `any` without justification; no dead code reintroduced; JSDoc per AGENTS.md §3 on touched classes/methods.
5. Invariants (§4) re-checked per phase's gates; plan checkboxes updated with evidence (files, behavior delta, tests).

---

## 12. Execution Order

1. **Phase 0** — baseline (B-1 fix + S characterizations + hot-flow baselines).
2. **CC-A** — pure primitives + typed configs.
3. **CC-B** — application policies (Rule-of-Three table).
4. **RP-INV + RP-CACHE-GUARD** — parallel, prove the pattern.
5. **RP-RES → RP-LIFECYCLE** — reservation chain.
6. **RP-AUTH** — auth/security architecture (S-1/S-2 enacted here iff approved; else R-only split preserving current semantics).
7. **CC-C** — design review + freeze port signatures.
8. **RP-ORDER ∥ RP-EXP** — parallel consumers of frozen ports.
9. **RP-OUTBOX** — lands CC-C adapters.
10. **RP-NOTIF** — last (consumes AUTH + OUTBOX).

---

## Appendix A — Preserved evidence index (Rev. 1 audits, still valid)

- Auth: `auth.service.ts` 1267 lines; `refresh:225-394`; cache/emit/`getRepository(User)` sites; TTL×3; hash×14.
- Reservation: `transitionWithInventoryInternal:498-686`; builder `:14-80` single caller; controller tx `:49,91,126,150`; `__orderBeforeStatus` hack.
- Order/inventory/cart/products: checkout `:50-273`, complete `:134-363`, `23514`×3, `assertOwner`×4, `FOR UPDATE`×6, `CACHE_MANAGER` in products + completion counter.
- Outbox/notifications: publisher 406 lines, worker 1229 lines, cleanup SQL `:33-36` bug (now P0-1), dedup×3, envelope×3, `EMAIL_PROVIDER`×2 modules, `@Optional` fail-opens (now OD-1-gated).

## Appendix B — Unresolved decisions requiring human approval

1. **S-1**: which JWT path survives (`JwtStrategy` sole vs `JwtGuard` delegates) — RP-AUTH.
2. **S-2**: `validateResetToken` lock vs read-only-with-recheck — RP-AUTH.
3. **OD-1 set**: each `@Optional()`→required conversion (expiration `OutboxService`, worker/bulk/channels deps, `NOTIFICATION_SERVICE` absence semantics, Redis-down fail-open retention) — RP-EXP / RP-OUTBOX / RP-NOTIF.
4. **Inventory `ParseUUIDPipe`/rate-limit gaps** (validation/behavior-adjacent) — RP-INV / RP-CACHE-GUARD: pin behavior first, change only as approved B.
5. **`register` response `data:newUser`** — pin password-absence by test in RP-AUTH; any change is S-gated.
6. **R-4 WS `tokenVersion`** — fix scope approved in RP-NOTIF with auth-track input (characterized in P0-4).
