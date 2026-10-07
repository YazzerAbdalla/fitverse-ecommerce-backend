# Quickstart: Payment Simulation Demo (no Stripe)

**Prereqs**: `docker-compose up -d` (postgres/redis/rabbitmq), app on `http://localhost:3000`, seeded products with inventory.

```bash
export BASE=http://localhost:3000
TS=$(date +%s); EMAIL="pay-$TS@test.com"; PASS="Password123!"

# 1. Register + login (normal shopper — owner of everything below)
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Pay\",\"lastName\":\"Demo\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | head -c 200; echo
JWT=$(curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('accessToken',''))")
echo "JWT ${JWT:0:20}..."

# 2. Cart + checkout (creates Order PENDING + Reservation RESERVED)
PID=$(curl -s "$BASE/products?priceMin=0&priceMax=1000000" -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
curl -s -X POST $BASE/cart -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PID\",\"quantity\":1}" > /dev/null
ORDER_JSON=$(curl -s -X POST $BASE/order/checkout -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}')
echo "$ORDER_JSON" | head -c 400; echo
ORDER_ID=$(echo "$ORDER_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# 3a. SUCCESS path: intent → confirm success → COMPLETED
PAY_JSON=$(curl -s -X POST $BASE/payments/intent -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"orderId\":\"$ORDER_ID\"}")
echo "$PAY_JSON" | head -c 300; echo
PAY_ID=$(echo "$PAY_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST $BASE/payments/$PAY_ID/confirm -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"result":"success"}' | head -c 400; echo
curl -s $BASE/order/$ORDER_ID -H "Authorization: Bearer $JWT" | head -c 200; echo  # expect COMPLETED
curl -s $BASE/payments/$PAY_ID -H "Authorization: Bearer $JWT" | head -c 200; echo # expect SUCCEEDED

# 3b. DECLINE path (new cart + checkout + intent first, then):
# curl -s -X POST $BASE/payments/$PAY_ID2/confirm -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
#   -d '{"result":"declined","failureReason":"card_declined"}'  # → order FAILED, hold released
# 3c. Re-confirm same payment → 200 already-processed, zero delta.
# 3d. Cancel before confirm: POST /payments/$PAY_ID/cancel -d '{}' → CANCELLED.
```

**Negative probes**: second `intent` same order PENDING → same row 201; other user's `intent` → 403; `confirm {result:'bogus'}` → 400; `GET /payments?status=SUCCEEDED` → filtered list; 11th `intent` within the hour → 429 (shared checkout bucket).
