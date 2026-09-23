# Quickstart — Refresh Token Rotation — Phase 17

**Feature**: `013-refresh-token` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 1. Prereqs

```bash
docker-compose up -d          # postgres 17, redis 8, rabbitmq 4
npm install                   # add cookie-parser 1.4.6 + @types/cookie-parser if not present
npm run build
npm run migration:run         # applies 17xxxxxxxxxx-CreateRefreshToken
```

## 2. .env additions (.env.example)

```text
# Existing (unchanged)
JWT_SECRET=dev-secret-not-real
JWT_EXPIRES_IN=15m
RESET_TOKEN_TTL=15m
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# New Phase 17
REFRESH_TOKEN_TTL=7d
REFRESH_TOKEN_COOKIE_NAME=refresh_token
REFRESH_TOKEN_COOKIE_SECURE=false   # true in production (https)
REFRESH_RL_MAX=10
REFRESH_RL_WINDOW_MS=3600000
LOGOUT_RL_MAX=20
LOGOUT_RL_WINDOW_MS=3600000
LOGOUT_ALL_RL_MAX=10
LOGOUT_ALL_RL_WINDOW_MS=3600000
```

All read via `ConfigService`; never hardcode.

## 3. Cookie-parser wiring

`src/main.ts`:
```ts
import cookieParser from 'cookie-parser';
app.use(cookieParser()); // before app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}))
```

## 4. Manual E2E (curl + psql)

```bash
# register
curl -s -X POST http://localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d '{"firstName":"Alice","lastName":"Test","email":"alice@example.com","password":"P@ssw0rd!"}' | jq

# login → capture refreshToken + Set-Cookie
curl -i -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"P@ssw0rd!"}' | tee /tmp/login.txt
ACCESS=$(grep -o '"accessToken":"[^"]*"' /tmp/login.txt | cut -d'"' -f4)
REFRESH=$(grep -o '"refreshToken":"[^"]*"' /tmp/login.txt | cut -d'"' -f4)
echo $ACCESS $REFRESH
# Set-Cookie: refresh_token=<raw>; HttpOnly; Path=/auth; Max-Age=604800

# use accessToken for protected route (valid 15m)
curl -s http://localhost:3000/order -H "Authorization: Bearer $ACCESS" | jq
curl -s http://localhost:3000/cart -H "Authorization: Bearer $ACCESS" | jq

# simulate expiry: wait 15m or mock exp in tests; otherwise refresh immediately (also valid while access still valid)
# refresh via body
curl -s -X POST http://localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" | tee /tmp/refresh1.txt | jq
NEW_ACCESS=$(jq -r .accessToken /tmp/refresh1.txt)
NEW_REFRESH=$(jq -r .refreshToken /tmp/refresh1.txt)
echo "New $NEW_REFRESH"

# reuse old refresh → 401 theft branch + revoke-all
curl -s -X POST http://localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq
# -> 401 {statusCode:401, message:"Invalid or expired refresh token"}

# refresh via cookie (body {})
curl -s -X POST http://localhost:3000/auth/refresh -H "Cookie: refresh_token=$NEW_REFRESH" -H 'Content-Type: application/json' -d '{}' | jq
# -> 200 {accessToken, refreshToken} + Set-Cookie rotated again

# logout single session (idempotent 200)
curl -s -X POST http://localhost:3000/auth/logout -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$NEW_REFRESH\"}" | jq
curl -s -X POST http://localhost:3000/auth/logout -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$NEW_REFRESH\"}" | jq
# -> 200 both times

# logout-all (requires Bearer accessToken)
# login twice to get two refreshes
A=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"P@ssw0rd!"}' | jq -r .refreshToken)
B=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"P@ssw0rd!"}' | jq -r .refreshToken)
echo "Two sessions $A $B"
curl -s -X POST http://localhost:3000/auth/logout-all -H "Authorization: Bearer $NEW_ACCESS" | jq
# -> 200 {message:"All sessions revoked"} — User.tokenVersion 0→1, both A,B revoked
curl -s -X POST http://localhost:3000/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$B\"}" | jq
# -> 401
curl -s http://localhost:3000/order -H "Authorization: Bearer $ACCESS" | jq
# -> 401 tokenVersion mismatch (JwtStrategy)

# Google callback also issues refresh (if GOOGLE_* configured)
# curl -s http://localhost:3000/auth/google/callback?code=... (302→200 JSON {accessToken, refreshToken})

# rate limit 11th refresh from same IP → 429
for i in {1..11}; do echo -n "$i: "; curl -s -o /tmp/rl.txt -w "%{http_code}\n" -X POST http://localhost:3000/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"deadbeef...64hex"}'; done
# 11th -> 429 {Retry-After:3600, X-RateLimit-Limit:10, X-RateLimit-Remaining:0}
```

## 5. psql proofs

```sql
-- tokenHash is sha256, never raw
SELECT id, substr("tokenHash",1,6) AS prefix, "expiresAt", "revokedAt", "createdAt" FROM "RefreshToken" WHERE "userId"=:id ORDER BY "createdAt" DESC;
-- active count bounded to 5
SELECT count(*) FROM "RefreshToken" WHERE "userId"=:id AND "revokedAt" IS NULL; -- <=5
-- partial unique prevents duplicate active hash (if enabled)
-- purge 7d retention (nightly)
DELETE FROM "RefreshToken" WHERE ("revokedAt" IS NOT NULL AND "revokedAt" < NOW() - INTERVAL '7 days') OR ("revokedAt" IS NULL AND "expiresAt" < NOW() - INTERVAL '7 days');
```

## 6. Tests

```bash
npm run lint
npm run build                        # should PASS, no synchronize:true
npm run test -- --runInBand          # 013 unit: login creates hashed refresh 7d 64hex, refresh rotation FOR UPDATE single-winner, reuse 401 theft revoke-all, cap 5 LRU, logout idempotent 200, logout-all tokenVersion++ revoke all
npm run test -- src/modules/auth/test/refresh.integration.spec.ts --runInBand  # real PG FOR UPDATE + real Redis FLUSHDB, concurrent refresh Promise.all single 200+401, login×6 cap LRU, 7d purge, X-Email-Unverified header, Google callback refresh
npm run test:e2e -- --runInBand      # supertest: register→login→GET /order 200→POST /auth/refresh 200→reuse old 401→logout 200→logout-all 200 tokenVersion 1→GET /order 401→login new 200
```

## 7. Troubleshooting

- `req.cookies` undefined → ensure `app.use(cookieParser())` before `ValidationPipe`; fallback `req.headers.cookie` parsing exists.
- `401` on refresh with valid hash but `revokedAt NOT NULL` → check theft branch bulk revoke; `Logger.warn` prefix logged.
- `429` unexpected → `FLUSHDB` Redis `rl:*`; check `REFRESH_RL_WINDOW_MS` clamped `>=60000` else fallback + `Logger.warn`.
- Duplicate login `23505` on `tokenHash` partial unique — retry `crypto.randomBytes(32)` once (prob negligible).
- `cookie-parser` types: `npm i -D @types/cookie-parser`.
```

**Expected**: `POST /auth/login → 200 {accessToken, refreshToken} 64hex + Set-Cookie`, `POST /auth/refresh` `200` rotated + old `401` theft revoke-all, `POST /auth/logout` `200` idempotent, `POST /auth/logout-all` `200 tokenVersion++`, `GET /order` with old `accessToken` `401`, no `UPDATE inventory` from auth (`grep -c "client.emit" src/modules/auth/auth.service.ts` `0` outside tx, `grep -c "FOR UPDATE" src/modules/auth/auth.service.ts` `>=1`).

