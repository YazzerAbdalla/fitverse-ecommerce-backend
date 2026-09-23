# Quickstart: Reliability / Idempotency — Phase 12

**Feature**: `012-reliability-idempotency` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 1. Setup

```bash
docker-compose up -d          # postgres 17, redis 8, rabbitmq 4
npm install
npm run build
npm run migration:run         # if NotificationLog optional added, else no new migration (OutboxEvent already from Phase 11)
```

`.env` (already from Phase 11, no new vars beyond optional `IDEMPOTENCY_TTL`):
```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mini_ecommerce
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672
RABBITMQ_QUEUE=notification_queue
OUTBOX_BATCH_SIZE=100
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_PROCESSING_LEASE_MS=30000
OUTBOX_MAX_ATTEMPTS=5
OUTBOX_RETRY_BASE_MS=1000
OUTBOX_RETRY_MAX_MS=60000
OUTBOX_RETENTION_DAYS=30
EXPIRATION_CRON=*/30 * * * * *
EXPIRATION_MAX_RETRIES=3
IDEMPOTENCY_TTL=86400
JWT_SECRET=dev_secret_do_not_use_in_prod
JWT_EXPIRES_IN=15m
```

## 2. Manual Duplicate Expiration → 200 Idempotent (Story 1 + Q2 A)

```bash
# register → login → add cart
JWT=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"a@test.com","password":"Passw0rd!"}' | jq -r .accessToken)
# checkout → Order PENDING + Reservation RESERVED reserved 2 stock 10
ORDER_ID=$(curl -s -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}' | jq -r .order.id)
RES_ID=$(curl -s http://localhost:3000/reservations -H "Authorization: Bearer $JWT" | jq -r '.data[0].id')
# inventory before
curl -s http://localhost:3000/inventory/<productId> -H "Authorization: Bearer $JWT" | jq '{stock, reservedAmount, available}'
# first expire → 200 EXPIRED reserved 0
curl -s -X PATCH http://localhost:3000/reservations/$RES_ID/expire -H "Authorization: Bearer $JWT" | jq
# inventory after first
psql "$DATABASE_URL" -c "SELECT status, reservedAmount, stock FROM reservation JOIN inventory ON inventory.product_id = (SELECT productId FROM inventory LIMIT 1) WHERE reservation.id='$RES_ID'; SELECT stock, \"reservedAmount\" FROM inventory LIMIT 1;"
# second expire same id → 200 already EXPIRED 0 delta (Q2 A) + Logger + INCR counter
curl -s -X PATCH http://localhost:3000/reservations/$RES_ID/expire -H "Authorization: Bearer $JWT" | jq # expect 200 status EXPIRED
psql "$DATABASE_URL" -c "SELECT stock, \"reservedAmount\" FROM inventory LIMIT 1;" # still reserved 0 stock 10
# Redis counter
redis-cli GET "idempotency:duplicate:skipped:expiration" # → 1
```

Concurrency (two workers):
```bash
# Promise.all([expire, expire]) → one 200 EXPIRED, second 200 idempotent, reservedAmount decremented once
# verified via integration test --runInBand EXPLAIN FOR UPDATE
```

## 3. Duplicate Order Completion → 200 (Story 3)

```bash
# checkout again with new cart
ORDER2=$(curl -s -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $JWT" -d '{}' | jq -r .order.id)
# first complete → 200 COMPLETED stock 10→8
curl -s -X POST http://localhost:3000/order/$ORDER2/complete -H "Authorization: Bearer $JWT" | jq
psql "$DATABASE_URL" -c "SELECT status FROM \"order\" WHERE id='$ORDER2'; SELECT stock, \"reservedAmount\" FROM inventory LIMIT 1;"
# second complete same id → 200 COMPLETED 0 delta
curl -s -X POST http://localhost:3000/order/$ORDER2/complete -H "Authorization: Bearer $JWT" | jq # 200
psql "$DATABASE_URL" -c "SELECT stock, \"reservedAmount\" FROM inventory LIMIT 1;" # still 8 reserved 0
redis-cli GET "idempotency:duplicate:skipped:complete" # → 1
# outbox count
psql "$DATABASE_URL" -c "SELECT count(*) FROM outbox_event WHERE \"aggregateId\"='$ORDER2' AND \"eventType\"='order.completed';" # → 1
```

## 4. Notification Dedup SET NX + Counter (Story 2 + Q5 B)

```bash
# OutboxEvent PENDING → publisher SENT → worker receives eventId abc
# redeliver same envelope second time (simulate lease race):
psql "$DATABASE_URL" -c "UPDATE outbox_event SET status='PENDING', attempts=0, \"nextRetryAt\"=NOW() WHERE id='<eventId>' RETURNING id;"
# publisher poll → RMQ second delivery → worker logs duplicate skipped
# Redis
redis-cli SET "notification:processed:<eventId>" 1 EX 86400 NX # first 1, second 0
redis-cli GET "idempotency:duplicate:skipped:notification" # → 1 on second delivery
# NotificationLog fallback (if migrated)
psql "$DATABASE_URL" -c "SELECT count(*) FROM notification_log WHERE \"eventId\"='<eventId>';" # → 1 not 2
```

Bulk:
```bash
# sales campaign c1 with 10 users
curl -s -X POST http://localhost:3000/admin/notifications/sales # (if Phase 18 not yet, mock via notification.sendBulk job)
# Bull retry after 5 sent → second run SET NX 0 for first 5, 1 for remaining 5 → total Log 10 not 15
redis-cli KEYS "notification:send:sales:c1:*" | wc -l # → 10
```

## 5. Admin FAILED Requeue PATCH (Q1 B)

```bash
# Simulate FAILED
psql "$DATABASE_URL" -c "UPDATE outbox_event SET status='FAILED', attempts=5, \"lastError\"='ECONNREFUSED' WHERE id='<failedId>' RETURNING status;"
# list
curl -s "http://localhost:3000/admin/outbox?status=FAILED" -H "Authorization: Bearer $ADMIN_JWT" | jq '.data | length'
# requeue single (Admin only)
curl -s -X PATCH http://localhost:3000/admin/outbox/<failedId>/requeue -H "Authorization: Bearer $ADMIN_JWT" | jq # 200 PENDING
psql "$DATABASE_URL" -c "SELECT status, attempts FROM outbox_event WHERE id='<failedId>';" # PENDING 0
# non-Admin 403
curl -s -X PATCH http://localhost:3000/admin/outbox/<failedId>/requeue -H "Authorization: Bearer $JWT" | jq # 403
# requeue non-FAILED 409
curl -s -X PATCH http://localhost:3000/admin/outbox/<sentId>/requeue -H "Authorization: Bearer $ADMIN_JWT" | jq # 409
# publisher next poll 1s will claim and SENT
```

## 6. Poison Quarantine Exclusion (D2 + Q3 A)

```bash
# transient CHECK 23514 → poison count increments
psql "$DATABASE_URL" -c "SELECT * FROM inventory LIMIT 1;" # ensure reserved <= stock
# after 3 transient failures:
redis-cli GET "expiration:poison:count" # → 3
redis-cli GET "expiration:poison:quarantined" # → 1
# next 30s ticks log "expiration quarantined 86400s remaining" and skip
# idempotent 200 already EXPIRED does NOT increment:
curl -s -X PATCH http://localhost:3000/reservations/$RES_ID/expire -H "Authorization: Bearer $JWT" | jq # 200
redis-cli GET "expiration:poison:count" # still 3 (not 4)
```

## 7. Tests

```bash
npm run build
npm run test -- --runInBand           # unit + integration (real PG FLUSHDB Redis SET NX/INCR)
npm run test:e2e -- --runInBand       # duplicate expire 200, duplicate complete 200, PATCH requeue 403/409/200
```

Expected: `EXPLAIN` shows `Index Scan using reservation_status_expires_at` and `outbox_event status,nextRetryAt,createdAt` composite; `inventory CHECK 23514` not violated; `stock` single delta.

## 8. Verification

```bash
# Outbox retained FAILED queryable
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM outbox_event GROUP BY status;"
# Counters
redis-cli MGET "idempotency:duplicate:skipped:notification" "idempotency:duplicate:skipped:expiration" "idempotency:duplicate:skipped:complete"
# Logs grep
# reservation idempotent skip
# notification duplicate eventId=... skipped
# outbox requeue id=... by adminId
```

