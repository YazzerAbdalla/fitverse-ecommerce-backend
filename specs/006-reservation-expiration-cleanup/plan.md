# Implementation Plan: Reservation Expiration Cleanup (Phase 5)

**Branch**: `006-reservation-expiration-cleanup` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-reservation-expiration-cleanup/spec.md` (Phase 5 — `docs/plan.md` §§5.1-5.4 + clarifications Session 2026-09-16 — 5 Q&A: 60s SLA, BullMQ repeat, RabbitMQ `reservation.expired` post-commit, singleton `concurrency:1`, poison `EXPIRATION_MAX_RETRIES=3` log-every-retry then skip)

## Summary

Introduce the missing automated expiration worker that closes the Phase 5 gap: periodically scan `WHERE status='RESERVED' AND expiresAt <= NOW()` via the existing composite index `IDX_reservation_status_expiresAt`, and for each candidate execute the same transactional path as manual `PATCH /:id/expire` (`FOR UPDATE` Reservation → verify still `RESERVED` → `FOR UPDATE` sorted Inventories → `reservedAmount -= qty` only → `status=EXPIRED`) within a per-reservation `DataSource.transaction` using the passed `EntityManager`. Choose **BullMQ** as the repeat scheduler (clarified Q2: persistent distributed queue, `reservation-expiration` queue, `repeat` every `30s` to meet **60s SLA** from Q1) with `concurrency:1` singleton (Q4) so multi-replica deployments do not duplicate ticks — correctness still depends on `FOR UPDATE` row locks (single-winner: worker vs `complete`/`cancel`/manual `expire`/parallel ticks). After each successful commit, publish a minimal **RabbitMQ** event `reservation.expired` (`{reservationId, userId, expiredAt, inventoryIds}`) post-commit (Q3); publish failures do not roll back. Poison candidates that violate `CHECK reservedAmount>=0` or have missing `Inventory` rows are retried up to `EXPIRATION_MAX_RETRIES=3` each tick, logging every retry, then skipped (Q5) — batch continues. Reuses all Phase 1-4 entities/locks without new tables or columns; the only code is a new `ReservationExpirationService` + `ReservationExpirationProcessor` + wiring in `ReservationModule`/`AppModule`, plus real-PG integration/concurrency tests.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/common` 11.1.28, `@nestjs/typeorm` 11 + `typeorm` 1.1, `pg` 8.22, `@nestjs/bullmq` + `bullmq` (new — BullMQ repeat scheduler, Q2), `@nestjs/microservices` 11 + `amqplib`/`amqp-connection-manager` (existing — RabbitMQ `reservation.expired` post-commit, Q3), `ioredis` 5 (BullMQ backing Redis, existing via `@keyv/redis`), `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; no new tables/columns; uses existing `Reservation` composite index `status+expiresAt` for scan). Redis 8 via `bullmq` queue store (repeat state, not authoritative for reservation truth; per constitution I, Redis never drives expiry decision — DB field `expiresAt <= NOW()` does). RabbitMQ 4 via `ClientsModule` (`NOTIFICATION_SERVICE` RMQ transport, existing) only **after** DB commit for `reservation.expired`.  
**Testing**: Jest unit (`*.spec.ts` mocked `EntityManager`/`BullMQ`/`ClientsModule`), integration + concurrency + idempotency + batch/paging + `EXPLAIN` against **real PostgreSQL** (docker, `--runInBand`, `FOR UPDATE` single-winner), RabbitMQ publish mocked, Redis/BullMQ-queue mocked for unit but real Redis when available for integration; `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`  
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq) — no frontend, worker runs inside same Nest process via BullMQ processor.  
**Project Type**: Modular monolithic backend — REST `reservation` (`POST /reservations`, `GET /:id`, `GET /`, `PATCH /:id/complete|cancel|expire` unchanged) + internal BullMQ repeat job + RabbitMQ domain event; GraphQL `products` unchanged.  
**Performance Goals**: Scan-to-`EXPIRED` **within 60s of `expiresAt`** (SLA Q1, SC-001/SC-007); repeat interval **30s** default (configurable 15s-60s), `EXPIRATION_BATCH_SIZE` `10-100` default `10`; transactions short (only lock→check→mutate→save, no external I/O inside tx); row-level `FOR UPDATE` on `Reservation` + requested `Inventory` rows only, so disjoint reservations run in parallel; deterministic `inventoryId` sort prevents deadlocks; batch paging via `LIMIT` + `ORDER BY expiresAt ASC, id ASC`.  
**Constraints**: `synchronize:false` (no auto DDL); PostgreSQL is authoritative truth (`constitution I`); BullMQ singleton `jobId`+`concurrency:1` (Q4) + `FOR UPDATE` as correctness backstop; RabbitMQ `reservation.expired` only after commit (Q3), failures logged not rolled back; `EXPIRATION_MAX_RETRIES=3` default (Q5) — every retry logged, then skip poison; `EXPIRATION_ENABLED` flag to pause scheduling without affecting manual `PATCH /:id/expire`; global `ValidationPipe`/`AllExceptionsFilter`/`Logger` remain.  
**Scale/Scope**: Touches `src/modules/reservation/` (new `reservation-expiration.service.ts` + `reservation-expiration.processor.ts` + `reservation.module.ts` wiring) + `src/app.module.ts` (`BullModule.forRoot` if not already, plus `reservation-expiration` queue registration) + env keys (`EXPIRATION_INTERVAL_MS` canonical ms primary; `EXPIRATION_CRON` optional cron override; `BULLMQ_REPEAT` is BullMQ-derived repeat value, `EXPIRATION_BATCH_SIZE`, `EXPIRATION_ENABLED`, `EXPIRATION_MAX_RETRIES`) + tests (`reservation.service.spec.ts`, `reservation/integration` + new `expiration.integration.spec.ts`); 0 new DB tables/columns/migrations expected (only `bullmq` tables in Redis, not PG). 7 SCs map to 7+ integration/concurrency tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ **PASS** | Expiry decision is `WHERE status='RESERVED' AND expiresAt <= NOW()` against PostgreSQL composite index; `reservedAmount -= qty` and `status=EXPIRED` computed exclusively inside `FOR UPDATE` transaction from locked rows; Redis (BullMQ queue store) never holds reservation truth; RabbitMQ `reservation.expired` emitted **only after** commit (FR-003, Q3) |
| **II. Modular monolith — no premature microservices** | ✅ **PASS** | Worker lives **inside** the existing Nest process as BullMQ processor (`@Processor('reservation-expiration')`), no new service/process; single `ReservationModule` owns scheduling + service + processor, per `AGENTS.md` module boundaries |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ **PASS** | No new states; only `RESERVED→EXPIRED` via worker (same as manual FR-005); inventory effect `reservedAmount -= qty` only (stock unchanged) per constitution III; `available` remains derived, never mutated |
| **IV. Concurrency safety at DB level (no overselling/double-release)** | ✅ **PASS** | Core deliverable: per-candidate `FOR UPDATE` Reservation → sorted `FOR UPDATE` Inventories, deterministic ordering, single-winner among worker vs `complete`/`cancel`/manual `expire`/parallel ticks (FR-006, SC-004/SC-006); BullMQ `concurrency:1` singleton (Q4) is efficiency-only, `FOR UPDATE` is authoritative backstop; DB `CHECK`s (`reservedAmount>=0`) final guard + poison retry (Q5) |
| **V. Module boundaries, service-only collaboration** | ✅ **PASS** | `ReservationExpirationService` owns scan+transaction orchestration, `ReservationService.transitionWithInventoryInternal` re-used as shared helper (no duplicate logic); controller remains thin (no new REST endpoint); RabbitMQ publish via injected `ClientProxy` (`NOTIFICATION_SERVICE`) not via repository; no cross-module `@InjectRepository` |
| **VI. Spec-driven development** | ✅ **PASS** | Spec `spec.md` + 8 clarifications (3 original +5 Session 2026-09-16 Q&A) done before plan: Q1 60s SLA, Q2 BullMQ, Q3 RabbitMQ event, Q4 singleton, Q5 poison N-retry; no silent assumption; Phases 6-16 explicitly out of scope (`Out of Scope` §7) |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ **PASS** | Real-PG integration required for `expiresAt <= NOW()` scan, multi-item atomic, concurrent worker vs `complete`/`cancel`/worker, idempotency, batch paging, `EXPLAIN` index scan, poison CHECK rollback without batch abort; unit mocks only for guard/BullMQ/RabbitMQ; research D8 mandates `npm run test -- --runInBand` |
| **VIII. No invented APIs/payments/business rules** | ✅ **PASS** | No new REST endpoint, no new DB field, no payment; only internal BullMQ job contract + minimal RabbitMQ `reservation.expired` domain event (Q3) tied to FR-003/FR-009; TTL (`15m`) and predicate (`expiresAt <= NOW()`) reused from existing `DEFAULT_TTL_MS` and Phase 4 |
| **IX. Documentation is part of work** | ✅ **PASS** | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/006-reservation-expiration-cleanup/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` §5 exit criteria traceable |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (decisions D1-D8 preserve same invariants).

## Project Structure

### Documentation (this feature)

```text
specs/006-reservation-expiration-cleanup/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8, risks
├── data-model.md        # Phase 1 output — no new PG DDL, BullMQ/RabbitMQ/poison model, transaction shape
├── quickstart.md        # Phase 1 output — setup + manual + test quickstart
├── contracts/
│   └── reservation-expiration.md  # Phase 1 output — BullMQ job contract + RabbitMQ reservation.expired event
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── reservation/
│   │   ├── reservation.service.ts                 # share transition helper for worker (already reusable)
│   │   ├── reservation-expiration.service.ts      # NEW — scan WHERE status=RESERVED AND expiresAt<=NOW() ORDER BY expiresAt,id LIMIT :batchSize, per-candidate transitionWithInventoryInternal + RabbitMQ publish post-commit + EXPIRATION_MAX_RETRIES tracking
│   │   ├── reservation-expiration.processor.ts    # NEW — @Processor('reservation-expiration') BullMQ processor, repeat every 30s (60s SLA), concurrency:1, EXPIRATION_ENABLED guard, non-overlapping guard
│   │   ├── reservation.module.ts                  # MODIFY — imports BullModule.registerQueue({name:'reservation-expiration'}), imports ClientsModule for RabbitMQ, provides ReservationExpirationService + Processor, exports service
│   │   ├── entities/
│   │   │   ├── reservation.entity.ts              # unchanged (status, expiresAt, composite index status+expiresAt)
│   │   │   ├── reservation-item.entity.ts         # unchanged (quantity>0 CHECK, unique)
│   │   │   └── reservation-status.enum.ts         # unchanged
│   │   ├── dto/
│   │   │   └── create-reservation.dto.ts          # unchanged
│   │   ├── reservation.service.spec.ts            # extend: unit tests for expiration idempotent skip, poison branch
│   │   └── test/
│   │       ├── reservation.integration.spec.ts    # extend: reuse helpers
│   │       └── expiration.integration.spec.ts     # NEW — real-PG: scan predicate, not-yet-expired immunity, multi-item atomic, worker vs complete/cancel/worker single-winner, idempotency, batch paging, EXPLAIN index scan, poison CHECK rollback, RabbitMQ publish mock
│   ├── inventory/
│   │   └── entities/inventory.entity.ts           # unchanged (stock/reservedAmount/available, CHECKs)
│   ├── order/
│   │   └── entities/order.entity.ts               # unchanged (not touched)
│   ├── auth/ users/ products/ cart/               # unchanged
│   └── app.module.ts                              # MODIFY — BullModule.forRootAsync (ioredis) + reservation-expiration queue wiring, shared NOTIFICATION_SERVICE already present
├── config/ (.env: EXPIRATION_INTERVAL_MS/EXPIRATION_CRON/BULLMQ_REPEAT, EXPIRATION_BATCH_SIZE, EXPIRATION_ENABLED, EXPIRATION_MAX_RETRIES, REDIS_URL, RABBITMQ_URL/QUEUE)
├── data-source.ts                                 # no PG migration expected (synchronize:false)
├── migration/                                     # no new PG migration expected (BullMQ state lives in Redis, not PG)
└── test/
    └── app.e2e-spec.ts                            # optional quick expiration e2e (Phase 14 full E2E later)
```

**Structure Decision**: Single project (Option 1) — augment the existing `src/modules/reservation/` in place (service + processor) plus minimal `AppModule` BullMQ wiring; no new top-level module or PG migration; reuse existing `ReservationService` transactional helper, existing `NOTIFICATION_SERVICE` RMQ transport, and existing Redis infra for BullMQ backing store.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| BullMQ new dependency (`bullmq` + `@nestjs/bullmq` + `ioredis` already) | BullMQ provides persistent repeat scheduling, crash recovery (repeat re-enqueued after restart), and `concurrency:1` singleton needed to meet 60s SLA with multi-replica safety (Q2+Q4) | `@nestjs/schedule` `@Cron` is lightweight but in-memory only — loses ticks on restart, has no built-in distributed singleton, and would require a custom Redis lock to replicate BullMQ's repeat durability; for Phase 5 "eventually release" correctness is via `FOR UPDATE`, but operational SLA and crash recovery require persistence — BullMQ is the existing project pattern for expiration-style jobs per `docs/plan.md` §5.4 |
| RabbitMQ `reservation.expired` post-commit event (new domain event in Phase 5) | Clarified Q3 (option C) — observability/coupling for downstream consumers while keeping DB commit independent (publish after commit, failures logged not rolled back) | Silent (no event) would defer all integration to Phase 11, but product chose RabbitMQ now; isolating publish to after-commit preserves constitution I/Async principle and adds no transaction-time coupling |

*No other violations — all other gates PASS.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 clarify Q&A in spec Session 2026-09-16 now integrated — Q1 60s SLA 30s tick, Q2 BullMQ, Q3 RabbitMQ post-commit, Q4 singleton concurrency:1, Q5 poison EXPIRATION_MAX_RETRIES=3). Key decisions: D1 composite index scan predicate, D2 BullMQ repeat durability, D3 per-candidate FOR UPDATE reuse of Phase 4 helper, D4 singleton + FOR UPDATE two-layer safety, D5 RabbitMQ post-commit emit, D6 batch paging non-overlapping, D7 poison N-retry then skip, D8 real-PG integration + EXPLAIN. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): No new PG DDL (reuse `Reservation`/`ReservationItem`/`Inventory`); BullMQ Redis queue `reservation-expiration` (repeat 30s, jobId singleton, concurrency 1); RabbitMQ `reservation.expired` transient event payload; poison `Map<id,count>` + `skipSet` + `EXPIRATION_MAX_RETRIES=3`; per-candidate transaction `FOR UPDATE Reservation → sorted FOR UPDATE Inventories → reservedAmount-=qty → EXPIRED`; scan `WHERE status=RESERVED AND expiresAt <= NOW() ORDER BY expiresAt,id LIMIT batchSize` outside tx.
- **Contracts** → [contracts/reservation-expiration.md](./contracts/reservation-expiration.md): BullMQ queue `reservation-expiration` repeat job contract (`jobId` singleton, concurrency 1, EXPIRATION_ENABLED guard) + `ReservationExpired` RabbitMQ event `reservation.expired` (post-commit, at-most-once) + `processExpiredBatch(limit)` service method (`{scanned,expired,skipped,failed,retried}`) + unchanged `PATCH /:id/expire` (admin immediate).
- **Quickstart** → [quickstart.md](./quickstart.md): Env additions (`EXPIRATION_INTERVAL_MS=30000`, `EXPIRATION_BATCH_SIZE=10`, `EXPIRATION_ENABLED=true`, `EXPIRATION_MAX_RETRIES=3`, `REDIS_URL`, `RABBITMQ_URL`), `npm i bullmq @nestjs/bullmq` if needed, `npm run build/lint`, `docker-compose up -d`, manual curl/psql verification (expired past vs future immunity, batch paging 25/10, single-winner race, poison retry), `npm run test -- --runInBand` (+ EXPLAIN), RabbitMQ emmit mock assertion.

### Agent context update

`AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/006-reservation-expiration-cleanup/plan.md`) via `setup-plan.ps1` + manual correction of `AGENTS.md` (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md` or `cat AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Q1-Q5 clarifications are consistent with constitution I/III/IV/VII and do not introduce new state, new PG table, or cache-based expiry decisions. Complexity items (BullMQ persistence, RabbitMQ post-commit event) remain scoped and justified per `research.md` D2/D5.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 5 into ordered tasks (e.g.: 1) failing integration tests for `expiresAt <= NOW()` scan predicate and not-yet-expired immunity; 2) failing multi-item atomic and EXPLAIN index scan tests; 3) implement `ReservationExpirationService` scan + per-candidate `FOR UPDATE` reuse + `EXPIRATION_MAX_RETRIES` poison map + batch continue-on-failure; 4) implement `ReservationExpirationProcessor` BullMQ repeat (30s, 60s SLA, concurrency:1 singleton, EXPIRATION_ENABLED guard) + RabbitMQ post-commit publish + logging; 5) failing concurrent `worker vs complete` / `worker vs cancel` / `worker vs worker` single-winner and idempotent no-double-release tests; 6) batch paging 25/10 draining + poison CHECK rollback isolation; 7) verify `npm run lint/build/test -- --runInBand` and E2E with short interval + `docs/plan.md` backlog marker update).
