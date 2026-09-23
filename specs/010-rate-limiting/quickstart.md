# Quickstart: Rate Limiting / Distributed Throttling (Phase 10)

**Branch**: `010-rate-limiting` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

---

## 1. Prerequisites

- Node 20, npm, Docker Desktop
- PostgreSQL 17, Redis 8, RabbitMQ 4 via `docker-compose.yml`

```bash
docker-compose up -d
npm ci
```

Env (`.env`):

```dotenv
REDIS_URL=redis://127.0.0.1:6379
ORDER_CHECKOUT_RL_MAX=10
ORDER_CHECKOUT_RL_WINDOW_MS=3600000
ORDER_COMPLETE_RL_MAX=10
ORDER_COMPLETE_RL_WINDOW_MS=3600000
CART_RL_MAX=60
CART_RL_WINDOW_MS=3600000
PRODUCT_MUTATION_RL_MAX=30
PRODUCT_MUTATION_RL_WINDOW_MS=3600000
```

If `REDIS_URL` empty, guard logs `Redis URL not set, using in-memory rate limit (non-distributed)` — `GET /products` etc still works, per-instance counts fine for CI.

---

## 2. Manual Burst → 429

### 2.1 Auth (IP)

```bash
for i in {1..11}; do
  curl -s -i -H "X-Forwarded-For: 9.9.9.9" -H "Content-Type: application/json" \
    -d '{"email":"burst@test.com","password":"Test1234!"}' http://localhost:3000/auth/login | head -n 20
done
# first 10: 200/401 with X-RateLimit-Limit:10 Remaining:9..0
# 11th: 429 {statusCode:429, message:"Too Many Requests"} + Retry-After:3600
# retry from different IP: curl -H "X-Forwarded-For: 8.8.8.8" ... → 200 again
```

### 2.2 Checkout per-user (needs JWT)

```bash
TOKEN=$(curl -s http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"userA@test.com","password":"Test1234!"}' | jq -r .accessToken)
for i in {1..11}; do
  curl -s -i http://localhost:3000/order/checkout -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
done
# 10 × 201, 11th 429 X-RateLimit-Limit:10 before any Order row, userB from same IP still 201
```

### 2.3 Cart 60/h

```bash
for i in {1..61}; do
  curl -s -o /dev/null -w "%{http_code} %{header_x-ratelimit-remaining}\n" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"productId":"<uuid>","quantity":1}' http://localhost:3000/cart
done
# 61st 429 Limit:60, GET /cart still 200
```

### 2.4 Redis distributed (two instances simulation)

```bash
# open two terminals with same REDIS_URL, run app on :3000 and :3001 (PORT=3001)
redis-cli FLUSHDB
# instance A 5 POST /cart same user, instance B 56 → B 61st 429 shared counter proven
```

### 2.5 Fail-open (Redis down)

```bash
docker-compose stop redis
curl -s -i -H "X-Forwarded-For: 9.9.9.9" -H "Content-Type: application/json" \
  -d '{"email":"burst@test.com","password":"Test1234!"}' http://localhost:3000/auth/login
# → 200/401 with Logger.warn "RateLimit Redis fail-open for POST /auth/login: ECONNREFUSED" (docker logs)
docker-compose start redis
```

Swagger at `http://localhost:3000/api` lists `429` with `Retry-After` on each protected route.

---

## 3. Verification

```bash
npm run lint
npm run build
npm run test -- --runInBand          # unit + integration (real Redis FLUSHDB or shared Map)
npm run test:e2e                     # supertest bursts x11/x61 + GET still 200
```

Expected `≥20` suites + `8+` new rate-limit suites pass. `jest --runInBand` required (existing `@nestjs/bullmq` ESM `transformIgnorePatterns`).

---

## 4. Troubleshooting

- `429` even on first request: `redis-cli FLUSHDB` then retry; window still hot.
- `GET /products` 429: expected not throttled strict — read not in `LIMITS`, guard returns true.
- `store.client.incr` not found log: V1 tolerate `get+set`; atomic upgrade optional.
