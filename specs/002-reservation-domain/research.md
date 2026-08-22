# Research: Reservation Domain (Phase 2)

**Feature**: `002-reservation-domain` | **Date**: 2026-08-22

> Phase 0 — resolve all NEEDS CLARIFICATION from spec/plan. All decisions below
> are consistent with `docs/plan.md` §§2.1-2.3, constitution principles III/IV/V,
> and existing codebase conventions.

---

## 1. Reservation expiration TTL — default `expiresAt`

**Decision**: `expiresAt` is **required** at service level but **optional** in the
REST DTO. If the caller omits it, the service defaults to `now + 15 minutes`.
When supplied, `expiresAt` MUST be a future timestamp (strictly greater than `now`). Past or
equal-to-now values are rejected with `BadRequestException`.

**Rationale**: `docs/plan.md` §5.1 states authoritative rule `expires_at <= NOW()`
drives expiration; Phase 2 only models the field while Phase 5 implements the cleanup
worker. A short, fixed TTL (15 min) matches common e-commerce reservation patterns
and is the value referenced in prior planning discussions. Making it caller-optional
allows checkout flow to control hold duration without forcing every caller to compute it.

**Alternatives considered**:
- Make `expiresAt` fully caller-required (no default) → rejected: forces duplicate
  calculation in every caller; service default is a sensible safety net.
- 30 min / 1 hour TTL → rejected: longer holds increase inventory starvation under
  contention; 15 min is conservative and can be tuned in Phase 5 via config.
- Store duration instead of timestamp → rejected: plan explicitly says `expires_at`
  timestamp is the source of truth ( §5.1 ); duration would require derivation.

**Implementation**: `CreateReservationDto.expiresAt?: Date` (IsOptional, IsDateString,
custom validator `isFuture`). Service: `expiresAt ?? new Date(Date.now() + 15*60*1000)`.
Add `@Check('"expiresAt" > "createdAt"')` optional but not required; service validation is primary.

---

## 2. Ownership enforcement — owner-only vs admin

**Decision**: Reservation is **owner-scoped**. `create` uses `userId` from
`@CurrentUser('sub')`; `findById` / `listByUser` require that the caller is either
the owning `userId` or has `UserRoles.Admin`. Unauthenticated → `401`; wrong owner
without admin → `403 Forbidden`. `complete`/`cancel` also check ownership.

**Rationale**: Matches existing `Cart` module behavior (`Cart` is per-user, guarded
by `JwtGuard`) and constitution principle V (thin controllers + `Auth` decorator).
Reservation represents a temporary claim on inventory that must not be visible or
mutable by other users. Admin override is needed for support/ops.

**Alternatives considered**:
- Open read (any authenticated user can read any reservation) → rejected: leaks
  cross-user business state; violates least-privilege.
- Service-only (no controller, no auth) → rejected: Phase 2 benefits from a thin
  controller for testing and for later order integration; but service methods still
  accept `requestingUserId` so non-HTTP callers remain covered.

**Implementation**: Controller uses `@Auth()` (any authenticated) + `@CurrentUser()`.
Service signatures include `requestingUserId` and optional `requestingRole`; forbidden
if mismatch and not admin. Unit tests cover 401/403 paths.

---

## 3. `orderId` FK enforcement timing

**Decision**: `Reservation.orderId` is **nullable** `FK ON DELETE SET NULL`, declared
now. Service validates if `orderId` supplied but not found → `404`; otherwise stays
`NULL` until Phase 6 links on `RESERVED → COMPLETED`. After Phase 6 a migration
makes the FK strict when linked (cannot be dangling) — per `/speckit.clarify`
Session 2026-08-22 (nullable now, strict later).

**Rationale**: `Order` is still a stub; checkout transaction that links reservation
to order is Phase 6. Forcing a hard FK now would block Phase 2 creation without
a real order. Spec §FR-010 explicitly defers order integration. This preserves FK
intent while allowing incremental work, and documents the future strict phase.

**Alternatives considered**:
- No FK at all in Phase 2 (`orderId` plain string) → rejected: loses referential
  intent; adding later requires migration.
- Hard FK with `ON DELETE CASCADE` and require valid order on every reservation →
  rejected: blocks Phase 2 independence from Phase 6.

---

## 4. Duplicate `inventoryId` within same reservation

**Decision**: **Reject** duplicate `inventoryId` within the same reservation creation
request. Validation: DTO-level custom validator + service check + DB unique constraint
`@Unique(['reservationId', 'inventoryId'])` on `ReservationItem`. Error: `409 Conflict`
(DB unique) surfaced as `409`, DTO duplicate as `400`.

**Rationale**: Duplicate lines for the same inventory would require merge logic
(e.g., sum quantities) that is not specified in `docs/plan.md` §2.2. Rejecting is
simpler, explicit, and matches idempotency expectations (Phase 12). Caller should
send a single item per inventory.

**Alternatives considered**:
- Merge duplicates (sum quantities) → rejected: hides caller mistakes; would need
  to define merge semantics (not in spec) and complicates inventory availability
  checks later (Phase 3).
- Allow duplicates silently → rejected: would create ambiguous claim and complicate
  cleanup (which row to release).

---

## 5. `ReservationService` method signatures — accept `EntityManager` now?

**Decision**: Phase 2 service methods **REQUIRE `EntityManager` param now**
(e.g. `create(manager, requestingUserId, dto)`, `complete(manager, id, ...)`) per
`/speckit.clarify` Session 2026-08-22 (Option B). Caller owns the transaction in
Phase 3; Phase 2 uses `manager` even if no locking yet to avoid breaking API later.
Plain non-transactional wrappers may be added in Phase 3 for convenience.

**Rationale**: Per clarification, preparing the signature now avoids a breaking
change when Phase 3 introduces `BEGIN → FOR UPDATE lock → check available → increase
reservedAmount → create reservation` atomically. All Phase 2 callers will already
pass an `EntityManager` (or use `dataSource.transaction(m => service.create(m, ...))`
wrapper). Extra complexity is minimal: service obtains repos via `manager.getRepository(...)`.

**Alternatives considered**:
- Plain repository APIs (no `EntityManager`) → considered but rejected after
  clarification: would require overloads/breaking change in Phase 3.
- Introduce a separate `ReservationTransactionService` in Phase 2 → rejected:
  over-engineering for a representation-only phase; single service with manager param is simpler.

---

## 6. Controller surface for Phase 2

**Decision**: Thin **REST** controller is included in Phase 2:

- `POST /reservations` (Auth) — create
- `GET /reservations/:id` (Auth, owner/admin) — retrieve with items
- `GET /reservations` (Auth, owner-scoped, paginated) — list own reservations
- `PATCH /reservations/:id/complete` (Auth, owner/admin) — `RESERVED → COMPLETED` (status-only)
- `PATCH /reservations/:id/cancel` (Auth, owner/admin) — `RESERVED → CANCELLED`
- (Optional) `PATCH /reservations/:id/expire` — internal/admin; primary expiry is Phase 5 worker

All endpoints use `Auth()` + `CurrentUser`. DTOs validated by global `ValidationPipe`.

**Rationale**: Service-first is constitution principle, but a thin controller is
needed for integration testing and for later manual QA. Keeping mutations as
`PATCH .../complete|/cancel` makes state transitions explicit (no generic
`PUT status` that would bypass validation). This matches plan's intent: thin
controller that calls service and returns its result.

**Alternatives considered**:
- Service-only (no controller) in Phase 2 → rejected: would defer API design
  decisions and make Phase 2 harder to demo/test via HTTP.
- GraphQL for reservations → rejected: inventory/reservation/order are REST per
  `AGENTS.md` module map; products are GraphQL.

---

## 7. Additional technical choices

- **Enum storage**: Postgres enum type `reservation_status` (`RESERVED`, `COMPLETED`,
  `EXPIRED`, `CANCELLED`) via TypeORM `enum: ReservationStatus`. Simpler than
  `CHECK` and self-documenting.
- **Indexes**: As per plan §5.2 + docs constraints: `Reservation(status)`,
  `Reservation(expiresAt)`, `Reservation(userId)`, composite `(status, expiresAt)` for
  Phase 5 cleanup query `WHERE status='RESERVED' AND expiresAt <= NOW()`. Items:
  `(reservationId)`, `(inventoryId)`.
- **Quantity constraint**: `CHECK quantity > 0` on `ReservationItem` plus DTO
  `IsInt @Min(1)` — defense in depth.
- **Timestamps**: `CreateDateColumn` / `UpdateDateColumn` on both entities; `ReservationItem`
  does not need `updatedAt` separately but included for consistency.
- **No Redis/RabbitMQ/BullMQ in Phase 2**: Aligns with constitution — async only after commit.

---

## 8. Open questions carried forward (none blocking)

All NEEDS CLARIFICATION tagged in spec are now resolved above. Remaining Phase 2
exit check is representational only; no unresolved spec ambiguity blocks implementation.

