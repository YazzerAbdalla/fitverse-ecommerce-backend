# Quickstart: Admin Product & Stock (Phase 20 Demo Scope)

**Base**: `http://localhost:3000` | **Prereqs**: `docker-compose up -d`, `npm run build && npm run start:dev`, an admin JWT in `$ADMIN_JWT` and a customer JWT in `$JWT`.

## 1. List products with statuses

```bash
curl -s "http://localhost:3000/admin/products?page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_JWT" | jq '.data[] | {name, available, status}'
# → each row: {name, available, status: in-stock|low-stock|out-of-stock}
```

## 2. Search + filter

```bash
curl -s "http://localhost:3000/admin/products?search=phone&status=low-stock&lowThreshold=5&minPrice=0&maxPrice=1000" \
  -H "Authorization: Bearer $ADMIN_JWT" | jq '.meta, (.data | length)'
```

## 3. Add a product (stock omitted → 0 → out-of-stock)

```bash
curl -s -X POST http://localhost:3000/admin/products \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"name":"Demo Widget","description":"Demo product","price":150}' | jq
# → 201 with {available: 0, status: "out-of-stock"}

# Duplicate name → 409, nothing created
curl -s -X POST http://localhost:3000/admin/products \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"name":"Demo Widget","description":"dup","price":150}' | jq .statusCode  # 409
```

## 4. Adjust stock (delta-only)

```bash
PID="<product id>"
# Add 10
curl -s -X PATCH http://localhost:3000/admin/products/$PID/stock \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"delta":10}' | jq '{stock, available, status}'
# Set absolute 50 by diffing: read stock first, then send (50 - stock)
STOCK=$(curl -s http://localhost:3000/admin/products?search="Demo%20Widget" -H "Authorization: Bearer $ADMIN_JWT" | jq '.data[0].stock')
curl -s -X PATCH http://localhost:3000/admin/products/$PID/stock \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d "{\"delta\":$((50 - STOCK))}" | jq '{stock, available, status}'
# Over-decrement → 409, stock unchanged
curl -s -X PATCH http://localhost:3000/admin/products/$PID/stock \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"delta":-999999}' | jq .statusCode  # 409
```

## 5. Access control proof (customer denied)

```bash
curl -s "http://localhost:3000/admin/products" -H "Authorization: Bearer $JWT" | jq .statusCode        # 403
curl -s -X POST http://localhost:3000/admin/products -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{"name":"X","description":"Y","price":1}' | jq .statusCode    # 403
curl -s -X PATCH http://localhost:3000/admin/products/$PID/stock -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{"delta":1}' | jq .statusCode                                  # 403
```

## 6. Verify

```bash
npm run lint && npm run build
npm run test -- --runInBand specs-adjacent # unit + integration (real PG) + e2e per D8
```
