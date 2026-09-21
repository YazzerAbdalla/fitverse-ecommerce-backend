# Quickstart — Order Integration — Checkout-Only Reservation (Phase 6)

**Branch**: `007-order-integration` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This phase adds cart-only `POST /order/checkout` that atomically creates `Order`+`OrderItem`s+`Reservation`+`reservedAmount` and **refactors `POST /reservations` to be checkout-only** (User → `403`).

## 1. Prerequisites

- Docker services: `docker-compose up -d` (postgres, redis, rabbitmq) — same as Phase 5
- Node 20, `npm ci`
- No new `.env` keys for checkout in Phase 6 (Redis/RabbitMQ deferred per Q5). `JWT_SECRET`, `REDIS_URL`, `RABBITMQ_URL` existing.

No new PG queue — checkout is pure PostgreSQL transaction. Migration `17xxxxx-OrderIntegrationCheckoutOnly` corrects `Order`/`OrderItem`/`OrderStatus` enum; `synchronize:false`.

## 2. Install & Build

```bash
npm ci
npm run build   # should PASS after entity fixes (remove ManyToMany JoinTable)
npm run lint    # should PASS
```

## 3. Run App

```bash
docker-compose up -d
npm run start:dev
# logs: [Nest] OrderModule dependencies initialized, ReservationModule, CartModule
```

## 4. Manual Verification

### 4.1 Verify manual `POST /reservations` blocked for User

```bash
TOKEN_USER=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"user@example.com","password":"Pass1234!"}' | jq -r .accessToken)

curl -s -X POST http://localhost:3000/reservations \
  -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' \
  -d '{"items":[{"inventoryId":"<invId>","quantity":1}]}' | jq
# → {"statusCode":403,"message":"Reservation can only be created via POST /order/checkout"} (or 404 if deleted)
# Admin should still succeed if @Auth(Admin) kept:
# TOKEN_ADMIN=... curl POST /reservations as admin → 201
```

### 4.2 Happy checkout → Order + Reservation + Inventory

```bash
# 1) Register + login (or use existing)
curl -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' -d '{"firstName":"A","lastName":"B","email":"checkout_test@example.com","password":"Pass1234!"}'
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"checkout_test@example.com","password":"Pass1234!"}' | jq -r .accessToken)

# 2) Create products (GraphQL) and ensure inventories exist (seeder creates 5 products with stock)
# Use GraphQL or direct DB to note productIds + inventoryIds + price

# 3) Add to cart (validates available optimistically)
curl -X POST http://localhost:3000/cart/items -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"productId":"<prodA>","quantity":2}'
curl -X POST http://localhost:3000/cart/items -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"productId":"<prodB>","quantity":1}'

curl http://localhost:3000/cart -H "Authorization: Bearer $TOKEN" | jq .cart_items

# 4) Checkout (cart-only, empty body)
curl -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | jq
# → 201 {id, status:"PENDING", total:250, items:[...], reservationId, expiresAt}

# 5) Verify after commit
curl http://localhost:3000/order -H "Authorization: Bearer $TOKEN" | jq
curl http://localhost:3000/order/<orderId> -H "Authorization: Bearer $TOKEN" | jq '.items[].unitPrice' # should be 100/50 snapshot
curl http://localhost:3000/reservations/<reservationId> -H "Authorization: Bearer $TOKEN" | jq .status # → RESERVED, orderId == order.id
docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d mini_ecommerce -c "SELECT id, stock, \"reservedAmount\" FROM \"Inventory\" WHERE \"productId\" IN ('<prodA>','<prodB>');"
# → reservedAmount 0→2 for A, 0→1 for B, stock unchanged
curl http://localhost:3000/cart -H "Authorization: Bearer $TOKEN" | jq .cart_items # → []
```

### 4.3 Checkout rejects explicit `items[]` (cart-only)

```bash
curl -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"<prodA>","quantity":1}]}' | jq
# → 400 {message:["property items should not exist"]}
```

### 4.4 Single-winner concurrent checkout (needs real PG)

- Seed `A stock10 reserved9 available1`, two users each add `A qty1` to their carts, then fire in parallel via node script `Promise.all([fetch checkout user1, fetch checkout user2])` — expect one `201`, one `409`, `reservedAmount` exactly `10` after.
- Opposite order `[A,B]` vs `[B,A]` with `batchSize 10` should not deadlock.

### 4.5 Historical price isolation

```bash
# Update Product A price via direct DB or GraphQL mutation (if exposed)
docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d mini_ecommerce -c "UPDATE \"Product\" SET price=999 WHERE id='<prodA>';"
curl http://localhost:3000/order/<orderId> -H "Authorization: Bearer $TOKEN" | jq '.items[] | select(.productId=="<prodA>") | .unitPrice'
# → 100 (old snapshot, not 999)
# New checkout after price change should snapshot 999
```

## 5. Tests

```bash
# After refactor, old POST /reservations as User must be updated to expect 403
npm run test -- --runInBand src/modules/reservation/reservation.service.spec.ts
npm run test -- --runInBand src/modules/order/test/checkout.integration.spec.ts  # NEW
npm run test -- --runInBand  # full suite, 169+ Phase5 tests + new checkout tests
# E2E
npm run test:e2e  # register→cart→checkout→GET order→price mutation

# Verify manual POST blocked:
# integration: POST /reservations as User → 403, as Admin → 201 (if kept)
```

Parallel Jest without `--runInBand` may flake on inventory IDs — always use `--runInBand` per constitution VII.

## 6. Common pitfalls

- Sending `items` in checkout body → `400` forbidNonWhitelisted (intentional cart-only)
- Calling old `POST /reservations` as User → `403` (use checkout)
- Forgetting `FOR UPDATE` sortedIds → deadlock `[A,B]` vs `[B,A]` — keep `sort()` per `reservation.service.ts:81` pattern
- Publishing RabbitMQ inside tx → must not; Phase 6 has no publish
- Cart clearing via `deleteCartItemsInBackground` (fire-and-forget) → must use `EntityManager` DELETE inside tx for atomicity
