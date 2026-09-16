# Quickstart — Reservation Expiration Cleanup (Phase 5)

**Branch**: `006-reservation-expiration-cleanup` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This feature adds the missing automated expiration worker. No new REST endpoint — manual `PATCH /:id/expire` (admin, immediate) is unchanged. The worker is an internal BullMQ repeat job (every `30s` to meet **60s SLA** Q1) that scans `WHERE status='RESERVED' AND expiresAt <= NOW()` and releases `reservedAmount`.

## 1. Prerequisites

- Docker services: `docker-compose up -d` (postgres, redis, rabbitmq) — same as Phase 4
- Node 20, `npm ci`
- `.env` additions (via `ConfigService`, never hardcoded):

```env
# existing REDIS_URL, RABBITMQ_URL, JWT_SECRET, etc.
EXPIRATION_INTERVAL_MS=30000        # repeat interval, default 30s to meet 60s SLA (Q1)
# or EXPIRATION_CRON / BULLMQ_REPEAT cron string
EXPIRATION_BATCH_SIZE=10            # per-tick LIMIT, default 10 (range 10-100)
EXPIRATION_ENABLED=true              # when false, processor short-circuits but manual PATCH still works
EXPIRATION_MAX_RETRIES=3             # poison retry limit before skip (Q5)
REDIS_URL=redis://127.0.0.1:6379
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672
RABBITMQ_QUEUE=notification_queue
```

No new PG migration expected — `Reservation` composite index `status+expiresAt` already exists (migration `1755850000000`). BullMQ state lives in Redis, not PG. `synchronize:false` remains.

## 2. Install & Build

```bash
npm ci
# if BullMQ not yet installed (Q2):
npm install bullmq @nestjs/bullmq
npm install -D @types/bullmq  # if available

npm run build   # should PASS with no TS errors
npm run lint    # should PASS
```

BullMQ registers via `AppModule` `BullModule.forRootAsync` + `ReservationModule` `BullModule.registerQueue({name:'reservation-expiration'})` with singleton `jobId`.

## 3. Run App

```bash
docker-compose up -d
npm run start:dev
# logs: [ReservationExpirationProcessor] reservation-expiration queue registered, repeat every 30000ms
# logs: expiration tick: scanned=0 expired=0 skipped=0 failed=0 (when idle)
```

Toggle `EXPIRATION_ENABLED=false` to verify manual path still works while scheduler silent.

## 4. Manual Verification (curl / psql)

### 4.1 Create expired candidate (past expiresAt via direct PG for test)

```bash
# 1) Register + login to get JWTs
curl -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' -d '{"firstName":"A","lastName":"B","email":"exp_test@example.com","password":"Pass1234!"}'
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"exp_test@example.com","password":"Pass1234!"}' | jq -r .accessToken)

# 2) Create inventory-backed product and reservation via API (default TTL 15m, but we force past via DB)
# After creating reservation via POST /reservations, manually set expiresAt in past for test:
# psql (docker)
docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d mini_ecommerce -c "
  UPDATE \"Reservation\" SET \"expiresAt\" = NOW() - interval '5 minutes' WHERE id = '<reservationId>';
"

# 3) Verify still RESERVED before tick:
curl http://localhost:3000/reservations/<id> -H "Authorization: Bearer $TOKEN" | jq .status
# → RESERVED

# 4) Wait 30-60s (one tick, 60s SLA) or call internal batch directly via test helper / direct DB:
# For deterministic test, invoke service method via REPL or test:
# (via tsc node script) await dataSource.transaction(m => expirationService.processExpiredBatch(10))

# 5) Verify after tick:
curl http://localhost:3000/reservations/<id> -H "Authorization: Bearer $TOKEN" | jq .status
# → EXPIRED
# psql:
docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d mini_ecommerce -c "
  SELECT id, stock, \"reservedAmount\", (stock - \"reservedAmount\") AS available FROM \"Inventory\" WHERE id='<inventoryId>';
"
# → reservedAmount decremented by qty, stock unchanged
```

### 4.2 Not-yet-expired immunity

```sql
-- Create reservation with expiresAt = NOW() + 10m (future)
-- Wait for tick — status must stay RESERVED
SELECT status, expiresAt FROM "Reservation" WHERE id='<futureId>';
-- → RESERVED, expiresAt > NOW()
```

### 4.3 Batch paging

```bash
# Create 25 expired RESERVED across 5 inventories (script or loop via POST /reservations then UPDATE expiresAt to past)
# Wait 2-3 ticks (60-90s) or call processExpiredBatch three times with limit 10
# Verify all 25 eventually EXPIRED
SELECT status, count(*) FROM "Reservation" WHERE status='EXPIRED' GROUP BY status;
```

### 4.4 Single-winner race (manual vs worker)

```bash
# Create RESERVED with expiresAt = NOW() - 1m
# Fire in parallel (requires 2 terminals or node concurrency script):
#   A) curl PATCH /reservations/<id>/complete (owner)  → expects 200 EXPIRED? actually COMPLETED vs EXPIRED race — one wins
#   B) trigger worker processExpiredBatch(10) concurrently
# Expected: one 200 (either EXPIRED or COMPLETED), one 409, inventory mutated exactly once
```

### 4.5 Poison retry

```sql
-- Corrupt: set reservedAmount to 0 but reservation qty to 5 (so reservedAmount - qty would go negative)
UPDATE "Inventory" SET "reservedAmount"=0 WHERE id='<inventoryId>';
-- expiration tick will log warn, retry up to 3 times, then skip; batch continues
-- Check logs: [ReservationExpirationService] poison <id> attempt 1/3 ... final skip after 3
```

## 5. Tests

```bash
# Unit (mocked EntityManager, BullMQ, RabbitMQ)
npm run test -- --runInBand src/modules/reservation/reservation.service.spec.ts
# Integration + concurrency + batch + EXPLAIN (real PostgreSQL, --runInBand required)
npm run test -- --runInBand src/modules/reservation/test/expiration.integration.spec.ts

# Full suite (89+ from Phase 4 + new 15-20)
npm run test -- --runInBand

# E2E (optional quick flow)
npm run test:e2e  # test/jest-e2e.json

# EXPLAIN index check (inside integration spec, tags @integration maybe)
# The spec SC-008 query:
# EXPLAIN (ANALYZE, BUFFERS)
# SELECT id FROM "Reservation" WHERE status='RESERVED' AND "expiresAt" <= NOW() ORDER BY "expiresAt" ASC, id ASC LIMIT 10;
# Assert result contains 'Index Scan' using 'IDX_reservation_status_expiresAt'
```

Parallel Jest workers without `--runInBand` may flake on inventory IDs — always use `--runInBand` per constitution VII (observed in Phase 3: 89/89 stable).

## 6. RabbitMQ event verification

```bash
# Mock ClientProxy in unit/integration asserts:
# expect(mockClient.emit).toHaveBeenCalledWith('reservation.expired', expect.objectContaining({reservationId, status:'EXPIRED'}))
# With real RabbitMQ:
docker logs $(docker ps -qf name=rabbitmq) --tail 50
# Check service logs:
# [ReservationExpirationService] reservation.expired emitted for <id>
```

## 7. Common pitfalls

- Forgetting `EXPIRATION_ENABLED=false` still allows manual `PATCH /:id/expire` (FR-004) — test manual path with scheduler disabled.
- Using `Date.now()` in scan instead of `NOW()` — must be Postgres server time (`expiresAt <= NOW()` inclusive, boundary `== NOW()` eligible).
- Holding transaction while publishing RabbitMQ — must publish **after** COMMIT (FR-003), else rollback would lose event or hold lock while waiting on RMQ.
- Overlapping ticks — ensure `concurrency:1` + guard; if tick exceeds 30s, next tick must skip (log `skip overlapping tick`).
