# Quickstart: verify Order Cancellation manually

**Prereqs**: `docker-compose up -d` (postgres/redis/rabbitmq), `npm run build`,
`npm run start:dev`, base `http://localhost:3000`.

```bash
export BASE=http://localhost:3000
TS=$(date +%s); EMAIL="cancel-$TS@test.com"; PASS="Password123!"

# 1. Register + login
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" \
  -d "{\"firstName\":\"C\",\"lastName\":\"X\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | head -c 200; echo
JWT=$(curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jq -r .accessToken)

# 2. Add to cart + checkout (creates Order PENDING + Reservation RESERVED)
PID=$(curl -s -X POST $BASE/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ products(args:{page:1, limit:1}) { data { id } } }"}' | jq -r '.data.products.data[0].id')
curl -s -X POST $BASE/cart -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PID\",\"quantity\":1}" | head -c 200; echo
CO=$(curl -s -X POST $BASE/order/checkout -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}')
echo $CO | jq '{id, status, reservationId}'; ORDER_ID=$(echo $CO | jq -r .id)

# 3. Cancel → 200 CANCELLED + reason + reservationId
curl -s -X POST $BASE/order/$ORDER_ID/cancel -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{}' | jq

# 4. Re-cancel → 200 same state, zero inventory delta
curl -s -X POST $BASE/order/$ORDER_ID/cancel -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{}' | jq .status

# 5. Inventory: reserved released, stock unchanged
curl -s $BASE/inventory/$PID -H "Authorization: Bearer $JWT" | jq '{stock, reservedAmount}'

# 6. Outbox: order.cancelled row exists
# psql: SELECT "eventType", "aggregateId" FROM outbox_event WHERE "aggregateId"='<ORDER_ID>';

# 7. Negative: complete-after-cancel → 409; other-user cancel → 403
curl -s -X POST $BASE/order/$ORDER_ID/complete -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{}' | jq .statusCode  # expect 409
```
