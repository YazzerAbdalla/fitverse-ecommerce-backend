# Quickstart: Transaction-Safe Reservation (Phase 3)

**Feature**: `003-transaction-safe-reservation` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This guide verifies the Phase 3 implementation manually and via tests.

## 1. Prerequisites

- Docker running; PostgreSQL on `localhost:5432` (via `docker-compose up -d postgres` or `docker-compose up -d`).
- Node 20+, `npm install` done.
- Branch `003-transaction-safe-reservation` checked out; prior migrations applied (`npm run migration:run` should show reservation tables).
- `synchronize: false` in `src/data-source.ts` / `app.module.ts` TypeORM config (Phase 3 adds no migration).

## 2. Build & lint

```bash
npm run lint
npm run build
```

Both must pass with no errors.

## 3. Run tests

```bash
# Unit + integration (real PostgreSQL required — docker-compose up -d)
npm run test

# Or targeted:
npx jest src/modules/reservation/reservation.service.spec.ts --runInBand
npx jest src/modules/reservation/test --runInBand

# E2E (also exercises POST /reservations inside real app):
npm run test:e2e
```

Expected results (Phase 3):
- Unit: `ReservationService.create` shows `pessimistic_write` lock, sorted ordering, `available` check, `reservedAmount` increment, rollback on `409`/`404`/`400`.
- Integration: single-reservation happy path, `available` exceeded → `409` + rollback, unknown `inventoryId` → `404` + rollback, duplicate `inventoryId` → `400` + rollback, `quantity` violates `CHECK` → DB rejection.
- **Concurrency** (real DB, not mocked): `stock=10,reserved=8, qty=2 vs qty=2` → exactly one `201` + one `409`, final `reserved=10`; opposite-order `{A,B}` vs `{B,A}` → no deadlock (both transactions complete).

## 4. Manual API verification

Start the app:

```bash
npm run start:dev
# Swagger at http://localhost:3000/api (bearer auth)
```

### 4.1 Prepare identities + inventories

1. Register + login two users (A, B) via `POST /auth/register` and `POST /auth/login` to get JWTs.
2. List products (GraphQL) and resolve `productId → inventoryId` via `GET /inventory/:productId` (or query `Inventory` table: `SELECT id, stock, "reservedAmount" FROM "Inventory" LIMIT 5;`).
3. Optionally set deterministic stock for the concurrency test:
   ```sql
   UPDATE "Inventory" SET stock = 10, "reservedAmount" = 8
   WHERE id = '<inventoryId-under-test>';
   -- available = 2
   ```

### 4.2 Happy-path reservation (within available)

```bash
curl -X POST http://localhost:3000/reservations \
  -H "Authorization: Bearer <JWT_A>" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{ "inventoryId": "<id>", "quantity": 1 }],
    "expiresAt": "2030-01-01T00:00:00.000Z"
  }'
# expect 201, status RESERVED, items length 1, expiresAt ~ as requested

# Verify reservedAmount incremented:
curl http://localhost:3000/inventory/<productId> -H "Authorization: Bearer <JWT_A>"
# reservedAmount should be 9 (8+1)
```

### 4.3 Rejection — exceed available

```bash
# available is now 1 (10-9); request 2 should fail:
curl -X POST http://localhost:3000/reservations \
  -H "Authorization: Bearer <JWT_A>" \
  -H "Content-Type: application/json" \
  -d '{ "items": [{ "inventoryId": "<id>", "quantity": 2 }] }'
# expect 409, message "Insufficient available inventory for <id>. Available: 1, requested: 2"

# Verify no Reservation persisted and reservedAmount unchanged (still 9):
psql> SELECT count(*) FROM "Reservation" WHERE "userId" = '<userA>';
```

### 4.4 Rejection — duplicate inventoryId / past expiresAt / unknown inventoryId

```bash
# duplicate:
curl -X POST ... -d '{"items":[{"inventoryId":"<id>","quantity":1},{"inventoryId":"<id>","quantity":1}]}'
# expect 400 "Duplicate inventoryId in request"

# past expiresAt:
curl -X POST ... -d '{"items":[{"inventoryId":"<id>","quantity":1}],"expiresAt":"2000-01-01T00:00:00.000Z"}'
# expect 400 "expiresAt must be a future timestamp"

# unknown inventoryId:
curl -X POST ... -d '{"items":[{"inventoryId":"00000000-0000-0000-0000-000000000000","quantity":1}]}'
# expect 404
```

### 4.5 Concurrency test (manual, two terminals or `&` background)

```bash
# Reset to available=2:
psql> UPDATE "Inventory" SET stock=10, "reservedAmount"=8 WHERE id='<id>';

# Fire two concurrent POSTs for qty=2 (copy JWTs for users A and B):
curl -X POST http://localhost:3000/reservations -H "Authorization: Bearer <JWT_A>" -H "Content-Type: application/json" -d '{"items":[{"inventoryId":"<id>","quantity":2}]}' &
curl -X POST http://localhost:3000/reservations -H "Authorization: Bearer <JWT_B>" -H "Content-Type: application/json" -d '{"items":[{"inventoryId":"<id>","quantity":2}]}' &
wait

# Expect exactly one 201 and one 409. Then:
psql> SELECT stock, "reservedAmount", stock - "reservedAmount" AS available FROM "Inventory" WHERE id='<id>';
# reservedAmount must be 10 (not 12), available 0
```

### 4.6 Deterministic ordering — opposite payload order

```bash
# Need two inventories A2,B2 with known stock; set both to stock=10,reserved=0
curl -X POST http://localhost:3000/reservations -H "Authorization: Bearer <JWT_A>" -d '{"items":[{"inventoryId":"<A2>","quantity":1},{"inventoryId":"<B2>","quantity":1}]}' &
curl -X POST http://localhost:3000/reservations -H "Authorization: Bearer <JWT_B>" -d '{"items":[{"inventoryId":"<B2>","quantity":1},{"inventoryId":"<A2>","quantity":1}]}' &
wait
# Both should complete without deadlock (both 201 if enough available, or 409 per availability, but never a deadlock error)
```

## 5. DB checks

```sql
-- Verify no CHECK violation surfaced as 500:
SELECT indexname FROM pg_indexes WHERE tablename = 'Reservation';
SELECT conname, contype, consrc FROM pg_constraint WHERE conrelid = '"ReservationItem"'::regclass;
SELECT count(*) FROM "Reservation" WHERE status = 'RESERVED';
-- After concurrency test:
SELECT id, stock, "reservedAmount", stock - "reservedAmount" AS available FROM "Inventory" WHERE id='<id>';
```

## 6. Done

- All quickstart steps pass, tests green, lint/build green, no `synchronize`-driven DDL, no Redis/RabbitMQ used inside the reservation transaction (verify by searching `reservation.service.ts` for `cacheManager`/`amqp`/`bullmq` — none inside `create`).
