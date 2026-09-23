# Quickstart: Transactional Outbox (Phase 11)

**Feature**: `011-async-events-notifications` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Data Model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/outbox-contracts.md](./contracts/outbox-contracts.md) | **Date**: 2026-09-23

## Prerequisites

- `docker-compose.yml` services: `postgres:17` `redis:8` `rabbitmq:4` (`docker-compose up -d`).
- `.env` required (see `.env.example`):
  ```env
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/ecommerce
  REDIS_URL=redis://localhost:6379
  RABBITMQ_URL=amqp://guest:guest@localhost:5672
  RABBITMQ_QUEUE=notification_queue
  JWT_SECRET=dev-secret-do-not-use-in-prod
  JWT_EXPIRES_IN=15m
  EXPIRATION_INTERVAL_MS=30000
  EXPIRATION_BATCH_SIZE=10
  OUTBOX_BATCH_SIZE=100
  OUTBOX_POLL_INTERVAL_MS=1000
  OUTBOX_PROCESSING_LEASE_MS=30000
  OUTBOX_MAX_ATTEMPTS=5
  OUTBOX_RETRY_BASE_MS=1000
  OUTBOX_RETRY_MAX_MS=60000
  OUTBOX_RETENTION_DAYS=30
  ```
  Without `RABBITMQ_URL`, app still boots (`OutboxPublisher` logs `RABBITMQ_URL not set, skipping publish` and leaves rows `PENDING`).

## Setup

```bash
npm ci
docker-compose up -d
npm run build
# migration auto? synchronize:false → run migrations
npm run migration:run  # or npx typeorm migration:run -d src/data-source
docker-compose logs -f rabbitmq redis postgres  # optional health
curl http://localhost:3000/api  # Swagger
```

## Manual Verification (happy path)

```bash
# 1. register → login
curl -s -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"a@ex.com","password":"Password123!","firstName":"A","lastName":"B"}'
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"a@ex.com","password":"Password123!"}' | jq -r .accessToken)

# 2. seed product (admin GraphQL or via inventory REST increase) — use existing seeded products
curl -s http://localhost:3000/products -H "Authorization: Bearer $TOKEN" | jq .

# 3. add to cart (pick productId from previous)
PID=<productId>  # e.g., from psql SELECT id FROM product LIMIT 1
IID=$(psql $DATABASE_URL -t -c "SELECT id FROM inventory WHERE productId='$PID'" | xargs)
curl -s -X POST http://localhost:3000/cart -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"productId\":\"$PID\",\"quantity\":2}" | jq .

# 4. checkout (cart-only, creates Order PENDING + OutboxEvent PENDING)
curl -i -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" -H 'X-Request-Id: 550e8400-e29b-41d4-a716-446655440000'
# → 201 {"order":{"id":"o1","status":"PENDING"},"reservation":{"id":"r1"},"items":[...]}

# 5. verify atomic outbox row (should exist before publisher marks SENT)
psql $DATABASE_URL -c "SELECT id, eventType, aggregateId, status, attempts, payload->>'correlationId' as corr, payload->>'version' as v FROM outbox_event WHERE aggregateId='o1' AND eventType='order.created';"
# → 1 row status PENDING (or PROCESSING→SENT within 1s)

# 6. wait 1s for publisher tick, then verify SENT
sleep 2
psql $DATABASE_URL -c "SELECT id, eventType, status, attempts, sentAt, lastError FROM outbox_event WHERE aggregateId='o1';"
# → status SENT, sentAt not null, attempts 0
docker-compose logs rabbitmq | grep "order.created"  # if RabbitMQ management plugin shows queued

# 7. complete order (creates order.completed outbox)
OID=o1  # from step 4
curl -s -X POST http://localhost:3000/order/$OID/complete -H "Authorization: Bearer $TOKEN" | jq .
psql $DATABASE_URL -c "SELECT eventType, status, payload->>'eventId' FROM outbox_event WHERE aggregateId='$OID' ORDER BY createdAt;"
# → order.created SENT, order.completed PENDING→SENT
```

## Failure Path (RMQ down → outbox durable)

```bash
# stop rabbitmq
docker-compose stop rabbitmq
# checkout again (add to cart first if cleared)
curl -s -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" | jq .
# → still 201

psql $DATABASE_URL -c "SELECT id, eventType, status, attempts, nextRetryAt, left(lastError,40) FROM outbox_event WHERE status='PENDING' ORDER BY createdAt DESC LIMIT 5;"
# → attempts 1→ lastError contains ECONNREFUSED, nextRetryAt ≈ NOW()+1s, status PENDING (not FAILED, not deleted)
# restart rabbitmq, wait poll, verify SENT
docker-compose start rabbitmq
sleep 3
psql $DATABASE_URL -c "SELECT status, attempts, sentAt FROM outbox_event WHERE status='SENT' ORDER BY sentAt DESC LIMIT 1;"
```

## Expiration Path (creates two events)

```bash
# force expiration: create reservation with expiresAt 1s ago via psql (or set short TTL)
psql $DATABASE_URL -c "UPDATE reservation SET expiresAt = NOW() - interval '1 minute' WHERE id='r1';"
# trigger BullMQ tick early or wait 30s
npm run test -- --runInBand src/modules/reservation/test/expiration.integration.spec.ts  # or wait
psql $DATABASE_URL -c "SELECT eventType, aggregateId, status FROM outbox_event WHERE payload->>'reservationId'='r1' OR aggregateId='o1' ORDER BY createdAt;"
# → reservation.expired PENDING→SENT + order.cancelled PENDING→SENT (if order PENDING)
psql $DATABASE_URL -c "SELECT status, reservedAmount, stock FROM inventory WHERE id='$IID';"
# → reservedAmount decremented, stock unchanged for expire-cancel
```

## Lease Reclaim Simulation

```bash
psql $DATABASE_URL -c "UPDATE outbox_event SET status='PROCESSING', processingStartedAt=NOW() - interval '60 seconds' WHERE status='PENDING' LIMIT 1 RETURNING id;"
sleep 2  # next poll reclaims
psql $DATABASE_URL -c "SELECT id, status, processingStartedAt FROM outbox_event WHERE id='<id-from-above>';"
# → status PROCESSING with fresh processingStartedAt or SENT if publish succeeded
```

## Rate-limit + validation guard (zero rows)

```bash
# 429 path: hammer checkout 11× quickly (limit 10/h/user)
for i in {1..11}; do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN"; done
# → 11th 429, and
psql $DATABASE_URL -c "SELECT count(*) FROM outbox_event WHERE createdAt > NOW() - interval '1 minute' AND eventType='order.created';"  # 10 not 11

# 400 empty cart
curl -s -X DELETE http://localhost:3000/cart -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" | jq .  # 400 Cart is empty
psql $DATABASE_URL -c "SELECT count(*) FROM outbox_event WHERE createdAt > NOW() - interval '1 minute';"  # unchanged
```

## Tests

```bash
npm run lint
npm run build
npm run test -- --runInBand          # unit: DataSource mock + OutboxPublisher claim/lease/backoff + NotificationWorker duplicate
npm run test -- --runInBand src/modules/outbox  # outbox-specific
# integration (real PG + mocked ClientProxy)
npm run test -- --runInBand src/modules/order/test src/modules/reservation/test -- --detectOpenHandles
npm run test:e2e  # register→cart→checkout→outbox PENDING→SENT→complete→SENT (+ RMQ-down simulate)
```

## Ops Queries

```sql
-- publisher health
SELECT status, count(*), min(nextRetryAt), max(attempts) FROM outbox_event GROUP BY status;
-- EXPLAIN publisher query uses composite index
EXPLAIN SELECT * FROM outbox_event WHERE (status='PENDING' AND nextRetryAt<=NOW()) OR (status='PROCESSING' AND processingStartedAt < NOW() - INTERVAL '30 seconds') ORDER BY createdAt ASC LIMIT 100 FOR UPDATE SKIP LOCKED;
-- requeue FAILED
UPDATE outbox_event SET status='PENDING', attempts=0, nextRetryAt=NOW(), lastError=NULL, processingStartedAt=NULL WHERE id='uuid' AND status='FAILED' RETURNING *;
-- purge old SENT/FAILED (retention 30d, run nightly)
DELETE FROM outbox_event WHERE (status='SENT' AND sentAt < NOW() - INTERVAL '30 days') OR (status='FAILED' AND createdAt < NOW() - INTERVAL '30 days');
```

## Swagger

`GET /api` lists `POST /order/checkout` `201` + `Async event: order.created via transactional outbox (OutboxEvent PENDING → OutboxPublisher → RabbitMQ notification_queue)` in description; `AllExceptionsFilter` does not turn publisher `FAILED` into `500`.
