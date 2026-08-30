# ADR 0009: Reservation Domain — EntityManager Writes and State Machine (Phase 2)

**Date**: 2026-08-22
**Status**: Accepted
**Feature**: 002-reservation-domain (Phase 2)

## Context

Phase 2 must introduce `Reservation` as temporary ownership of one or more `Inventory` rows without yet implementing transactional locking, `reservedAmount` mutation, or expiration cleanup (deferred to Phases 3–5 per spec FR-010). The design in `specs/002-reservation-domain/plan.md` requires service write signatures to accept `EntityManager` now so Phase 3 can add `FOR UPDATE` locking without a breaking change (Option B from `/speckit.clarify` Session 2026-08-22). We must also decide DB representation, auth, and transition rules.

Alternatives considered:
1. Service writes with plain repositories (no `EntityManager`) — rejected in clarify: would require overloads/breaking change in Phase 3 when wrapping `create` in `BEGIN → FOR UPDATE → check available → increment reservedAmount → create reservation` atomically.
2. Separate `ReservationTransactionService` in Phase 2 — rejected: over-engineering for representation-only phase; single service with manager param is simpler.
3. Postpone `EntityManager` until Phase 3 — consistent with simplest current code but discarded per constitution IX/C2 traceability; milestone order explicitly permits representation before atomicity.

## Decision

- Entities: `Reservation` (`id` uuid PK, `userId` uuid FK → User `CASCADE` indexed, `orderId` uuid nullable FK → Order `SET NULL` indexed, `status` enum `reservation_status` default `RESERVED` indexed, `expiresAt` timestamptz NOT NULL indexed, `createdAt`/`updatedAt`, composite `INDEX(status,expiresAt)` for Phase 5 cleanup `WHERE status='RESERVED' AND expiresAt<=NOW()`, relations `ManyToOne User/Order`, `OneToMany ReservationItem cascade`); `ReservationItem` (`id` uuid PK, `reservationId` FK → Reservation `CASCADE` indexed, `inventoryId` FK → Inventory `CASCADE` indexed, `quantity` int `CHECK quantity>0`, `Unique(reservationId,inventoryId)`, `createdAt`/`updatedAt`). Table names lowercased `reservation`/`reservation_item` matching existing `inventory`/`user` convention.
- Enum storage: Postgres enum `reservation_status` values `RESERVED|COMPLETED|EXPIRED|CANCELLED`.
- DTOs validated by global `ValidationPipe` (`whitelist+forbidNonWhitelisted+transform`): `CreateReservationDto` (optional `expiresAt` IsDateString, `orderId` optional uuid, `items` ArrayMinSize 1 ValidateNested Type ReservationItemDto with `inventoryId` uuid, `quantity` IsInt Min 1). Service defaults `expiresAt` to `now+15m` if omitted, rejects past/non-future with `400`; rejects duplicate `inventoryId` within request `400` (DB unique → `409`); validates each `inventoryId` exists `404`, `orderId` exists `404` or stays `NULL`.
- Auth: `ReservationController` class-level `@Auth(UserRoles.User, UserRoles.Admin)` + `expire` method-level `@Auth(UserRoles.Admin)`; `CurrentUser('sub')` for `requestingUserId`, `CurrentUser('role')` for role; `assertOwner` enforces owner-or-admin else `403`, unauth `401`; `findById`/`complete`/`cancel` check ownership.
- State machine (service-enforced, constitution III): `ALLOWED_TRANSITIONS = { RESERVED:[COMPLETED,EXPIRED,CANCELLED], COMPLETED:[], EXPIRED:[], CANCELLED:[] }`; `validateTransition` throws `ConflictException 409` on invalid. `complete` optionally sets `orderId` after existence check. `expire` is admin/internal, no owner check (Phase 5 worker is primary).
- Signatures: writes `create(manager, userId, dto)`, `complete(manager, userId, id, dto?, role?)`, `cancel(manager, userId, id, role?)`, `expire(manager, id)`; reads `findById(userId, id, role?)`, `listByUser(userId, pagination, filter?, role?)` return `{data, meta}` with existing pagination shape. Controller wraps writes in `dataSource.transaction(manager => service.method(manager,...))`.
- Module: `ReservationModule` (`TypeOrmModule.forFeature([Reservation, ReservationItem])`, `exports: [ReservationService]` for Phase 6 Order) imported in `AppModule`; `data-source.ts` lists `Reservation`/`ReservationItem` (+ Inventory fix) in `entities`, `synchronize:false`, migration `1755850000000-CreateReservationAndReservationItem` creates enum + tables + 6 indexes + FKs + checks + unique, `down` drops tables+type.
- No `Inventory.reservedAmount` mutation, no `FOR UPDATE`, no worker/cron in Phase 2 (explicitly out of scope per FR-010).
- Testing (FR-011): unit `reservation.service.spec.ts` (30 tests: default TTL, future check, duplicate, unknown inventory/order, transition matrix, ownership 403/404, pagination meta) with mocked `DataSource`/`EntityManager`; integration `test/reservation.integration.spec.ts` (8 tests against real PostgreSQL: persist items, `CHECK quantity>0`, unique, FK, indexes, create→get, complete→409, scoping). Concurrency/expiration deferred.

## Consequences

**Positive**
- Phase 3 can add pessimistic locks inside the existing `dataSource.transaction` without signature changes; callers already pass `EntityManager`.
- Single source of truth remains PostgreSQL; Redis/RabbitMQ unused in Phase 2 (constitution I).
- Thin controller, service-only state mutation, module boundary respected (no `@InjectRepository(Reservation)` outside reservation).

**Negative / Migration**
- Writing tests requires mocking `DataSource` + `manager.getRepository` (slightly more setup than plain repo mocks).
- `expire` currently admin REST rather than worker; Phase 5 will add worker querying `status+expiresAt` index.

## Verification

- `npm run build` passes; migration applied via `npx ts-node -r tsconfig-paths/register run-migrations.ts` (creates `reservation`/`reservation_item` + enum + indexes).
- `npm run test -- reservation.service.spec` 30 pass; `npm run test -- reservation.integration.spec` 8 pass; `npm run test -- --runInBand` 80 pass.
- Manual quickstart: `POST /reservations` 201 RESERVED, `GET /:id` 200, `GET /` paginated, `PATCH /:id/complete` 200, second `cancel` 409, `quantity 0` 400, past `expiresAt` 400 verified via integration.

