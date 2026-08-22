# Quickstart: Reservation Domain (Phase 2)

**Feature**: `002-reservation-domain` | **Branch**: `002-reservation-domain`

> Represents a temporary claim on inventory. Phase 2 is model + state machine only.
> Inventory mutation and locking are Phases 3-4; expiration worker is Phase 5.

---

## Prerequisites

- Docker infra running: `docker-compose up -d` (postgres, redis, rabbitmq)
- `.env` configured (postgres, JWT, redis, rabbitmq)
- Phase 1 migration applied (Inventory); `synchronize: false`
- Install deps: `npm install`
- Build: `npm run build` (should pass on fresh checkout)

---

## Apply migration & seed

```bash
# Run migration for Reservation + ReservationItem (after implementation)
npm run migration:run   # or: npx typeorm migration:run -d src/data-source.ts

# Verify tables
psql $DATABASE_URL -c "\d Reservation"
psql $DATABASE_URL -c "\d ReservationItem"
```

Expected: enum `reservation_status`, tables `Reservation`, `ReservationItem`, indexes on
`userId, status, expiresAt, (status,expiresAt), reservationId, inventoryId`, FKs, `CHECK quantity > 0`, unique `(reservationId, inventoryId)`.

---

## Manual API test (Phase 2 controller)

```bash
# 1. Register & login
curl -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"u@test.com","password":"Pass1234!","name":"U"}'

TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"u@test.com","password":"Pass1234!"}' | jq -r .access_token)

# 2. Get an inventory id (Phase 1)
INV_ID=$(curl -s http://localhost:3000/inventory -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id // .[0].id')
# or directly via DB: psql -c "SELECT id FROM \"Inventory\" LIMIT 1"

# 3. Create reservation (default expiresAt = now+15m if omitted)
curl -s -X POST http://localhost:3000/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"inventoryId\":\"$INV_ID\",\"quantity\":2}]}" | jq

# With explicit expiresAt
curl -s -X POST http://localhost:3000/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"expiresAt\":\"2026-08-22T12:15:00.000Z\",\"items\":[{\"inventoryId\":\"$INV_ID\",\"quantity\":1}]}" | jq

# 4. Retrieve reservation
RES_ID="<id from previous>"
curl -s http://localhost:3000/reservations/$RES_ID -H "Authorization: Bearer $TOKEN" | jq

# 5. List own reservations (paginated)
curl -s "http://localhost:3000/reservations?page=1&limit=10" -H "Authorization: Bearer $TOKEN" | jq

# 6. Transition tests
curl -s -X PATCH http://localhost:3000/reservations/$RES_ID/complete -H "Authorization: Bearer $TOKEN" | jq
# Subsequent complete/cancel on same id should yield 409

curl -s -X PATCH http://localhost:3000/reservations/$RES_ID/cancel -H "Authorization: Bearer $TOKEN" | jq  # → 409 if already COMPLETED

# 7. Validation error cases
curl -s -X POST http://localhost:3000/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"inventoryId\":\"$INV_ID\",\"quantity\":0}]}" | jq  # → 400 quantity

curl -s -X POST http://localhost:3000/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"expiresAt\":\"2020-01-01T00:00:00.000Z\",\"items\":[{\"inventoryId\":\"$INV_ID\",\"quantity\":1}]}" | jq  # → 400 expiresAt past
```

---

## Tests

```bash
# Unit tests (service transition matrix, validation)
npm run test -- reservation.service.spec

# Integration tests (real PostgreSQL — constraints, FKs, unique, CHECK)
npm run test -- reservation.integration.spec  # or: npm run test:integration

# All
npm run test
npm run lint
npm run build
```

**Phase 2 exit check**: All tests above pass; `Reservation` + `ReservationItem`
persisted and retrieved; invalid transitions yield 409; DB `CHECK quantity > 0` and
unique `(reservationId, inventoryId)` verified against real PostgreSQL.

---

## Next phases

- **Phase 3**: Wrap `create` in `dataSource.transaction` with `pessimistic_write` locks on `Inventory` rows (deterministic ordering) + `available >= quantity` check + `reservedAmount += quantity`.
- **Phase 4**: Inventory effects on `complete` (`stock -= qty; reservedAmount -= qty`) and `cancel/expire` (`reservedAmount -= qty`).
- **Phase 5**: Worker querying `WHERE status='RESERVED' AND expiresAt <= NOW()` with row locks and idempotent release.
