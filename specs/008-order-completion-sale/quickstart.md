# Quickstart: Order Completion / Sale (Phase 7)

**Branch**: `008-order-completion-sale` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-09-22

## Prerequisites

```bash
docker-compose up -d          # postgres 17, redis 8, rabbitmq 4
npm ci                        # Node 20
cp .env.example .env          # JWT_SECRET, DATABASE_URL, REDIS_URL, RABBITMQ_URL (no new keys in Phase 7)
npm run build                 # verify tsc
npm run lint                  # eslint --fix
```

`synchronize:false` — no new migration in Phase 7.

## 1. Manual Checkout → Sale Flow

```bash
# register + login → capture $JWT
curl -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" \
  -d '{"firstName":"A","lastName":"B","email":"sale@test.com","password":"Password123!"}'
JWT=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"sale@test.com","password":"Password123!"}' | jq -r .accessToken)

# list products → capture $PID_A / $PID_B
curl -s http://localhost:3000/products | jq

# add to cart
curl -X POST http://localhost:3000/cart/items -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PID_A\",\"quantity\":2}"
curl -X POST http://localhost:3000/cart/items -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PID_B\",\"quantity\":1}"

# checkout (cart-only)
curl -X POST http://localhost:3000/order/checkout -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}' | tee /tmp/checkout.json
ORDER_ID=$(jq -r .id /tmp/checkout.json)
RESERVATION_ID=$(jq -r .reservationId /tmp/checkout.json)
echo $ORDER_ID $RESERVATION_ID  # e.g. order PENDING, reservation RESERVED

# verify before sale
curl -s http://localhost:3000/order/$ORDER_ID -H "Authorization: Bearer $JWT" | jq .status  # PENDING
curl -s http://localhost:3000/reservations/$RESERVATION_ID -H "Authorization: Bearer $JWT" | jq .status  # RESERVED
curl -s http://localhost:3000/inventory/$PID_A | jq .reservedAmount  # 2
curl -s http://localhost:3000/inventory/$PID_A | jq .stock          # 10

# complete sale as owner (empty body)
curl -X POST http://localhost:3000/order/$ORDER_ID/complete -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}' | tee /tmp/complete.json
jq .status /tmp/complete.json          # COMPLETED
jq .reservation.status /tmp/complete.json  # COMPLETED

# verify after sale
curl -s http://localhost:3000/order/$ORDER_ID -H "Authorization: Bearer $JWT" | jq .status  # COMPLETED
curl -s http://localhost:3000/inventory/$PID_A | jq '{stock, reservedAmount, available: (.stock - .reservedAmount)}'  # stock 10→8, reserved 2→0, available 8
curl -s http://localhost:3000/reservations/$RESERVATION_ID -H "Authorization: Bearer $JWT" | jq .status  # COMPLETED
```

## 2. Invalid & Ownership Checks

```bash
# other user's order → 403
OTHER_JWT=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"other@test.com","password":"Password123!"}' | jq -r .accessToken)
curl -X POST http://localhost:3000/order/$ORDER_ID/complete -H "Authorization: Bearer $OTHER_JWT" -H "Content-Type: application/json" -d '{}'  # 403

# extra body → 400
curl -X POST http://localhost:3000/order/$ORDER_ID/complete -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"paymentId":"pay_123"}'  # 400 property paymentId should not exist

# already COMPLETED retry → 200 idempotent (no second stock decrement)
curl -X POST http://localhost:3000/order/$ORDER_ID/complete -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}'  # 200

# CANCELLED/EXPIRED → 409 (create an expired order via worker or short TTL)
curl -X POST http://localhost:3000/order/<cancelledOrderId>/complete -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}'  # 409 Invalid order transition
```

## 3. Historical Price Isolation

```bash
# checkout at price 100, then change product price, then complete — items still 100
# (Phase 6 already snapshots; completion does not re-read Product.price)
curl -s http://localhost:3000/order/$ORDER_ID -H "Authorization: Bearer $JWT" | jq '.items[0].unit_price'  # 100
# update product price via GraphQL/admin (or direct DB), then re-fetch
curl -s http://localhost:3000/order/$ORDER_ID -H "Authorization: Bearer $JWT" | jq '.items[0].unit_price'  # still 100
```

## 4. Concurrent Verification (integration test harness)

The real guarantee is via integration tests, not curl. Run with real PostgreSQL:

```bash
npm run test -- --runInBand  # unit + integration (--runInBand required for FOR UPDATE tests)
# Key suites (see plan):
# - order-completion.integration.spec.ts  — PENDING→COMPLETED stock-=qty, CANCELLED→409, 403, 404, idempotent, complete vs expire single-winner, EXPLAIN row-level lock
# - order.controller.spec.ts  — CompleteOrderDto empty-body 400, owner 403
npm run test:e2e -- --runInBand  # supertest: register→add→checkout→complete→GET order→price isolation
```

**Expected logs** (from OrderCompletionService):

```
[OrderCompletionService] Order <id> PENDING → COMPLETED via reservation <rid> (stock bulk −2)
[ReservationService] Reservation <rid> RESERVED → COMPLETED (via Order)
```

If `stock` would go negative (`CHK_inventory_stock_non_negative 23514`) → `409 Conflict` logged, transaction rolled back, order stays `PENDING`.

## 5. Checklist

- [ ] `POST /order/:id/complete` as owner → `200 COMPLETED` + `stock` decremented + `reserved` zeroed
- [ ] As other user → `403`; with extra body → `400`; missing reservation → `404`; `CANCELLED` → `409`; retry → `200` idempotent
- [ ] Concurrent `Promise.all([complete, complete])` same order → one stock decrement, both 200
- [ ] `GET /order/:id` after `Product.price 100→999` → `unit_price 100` still
- [ ] `npm run lint && npm run build && npm run test -- --runInBand` all pass
```

**Test gate**: All above curls return expected codes and final `npm run test -- --runInBand` is green before declaring Phase 7 done.
