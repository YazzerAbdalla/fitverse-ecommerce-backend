# Quickstart — Phase 18 Email Service

**Branch**: `014-email-service` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Data Model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/email-contracts.md](./contracts/email-contracts.md)

## Prerequisites

- Node 20, npm, Docker Desktop
- `docker-compose.yml` at repo root (`postgres 17`, `redis 8`, `rabbitmq 4`)

## 0. EnvVars

Add to `.env` (not committed) and `.env.example`:

```ini
# Existing (unchanged)
JWT_SECRET=dev-secret-not-for-prod
JWT_EXPIRES_IN=15m
RESET_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=7d
PORT=3000
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# Email (new, Phase 18) — Phase 18
EMAIL_PROVIDER=noop              # noop|smtp|ses|sendgrid (default noop, NoopEmailProvider for dev/test)
EMAIL_FROM="Mini E-Commerce <noreply@example.com>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=false                # true for 465
EMAIL_VERIFICATION_TTL=24h       # parseTtlMs s/m/h/d, invalid→24h+warn
EMAIL_RESET_TTL=15m              # reuse RESET_TOKEN_TTL, explicit alias
EMAIL_SALES_BATCH_SIZE=500
FRONTEND_URL=https://app.example.com
```

All read via `ConfigService`, never hardcoded. `Noop` in `dev/test` logs `[NoopEmail] to=* template=* link=*` without network.

## 1. Start Infra

```bash
docker-compose up -d
docker-compose ps # postgres 5432, redis 6379, rabbitmq 5672/15672
```

## 2. Install & Build

```bash
npm install
npm run build
```

## 3. Run Migration

```bash
npm run migration:run
# or: npm run typeorm migration:run -- -d data-source.ts  (per package.json)
# Creates: EmailVerificationToken + User.marketingOptIn + NotificationLog (synchronize:false)
```

Verify:

```bash
npx typeorm query "SELECT column_name FROM information_schema.columns WHERE table_name='user' AND column_name='marketingOptIn'" -- -d data-source.ts
npx typeorm query "SELECT to_regclass('EmailVerificationToken'), to_regclass('notification_log')" -- -d data-source.ts
```

## 4. Run App

```bash
npm run start:dev
# Swagger: http://localhost:3000/api (verify via GET|POST /auth/verify-email, POST /auth/resend-verification, POST /admin/notifications/sales, PATCH /users/me/preferences)
```

## 5. Manual Flows

### 5.1 Register → verify-email (P1)

```bash
# 1) Register (emailVerified false)
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Ali","lastName":"Test","email":"ali@example.com","password":"Password123","marketingOptIn":true}'
# 201 { message:"User created" } (201 from auth, verify email sent fire-and-forget)

# 2) Capture raw token via test hook (dev only) or NoopEmailProvider logs:
# In Node REPL or via test hook: AuthService.lastVerificationToken or NoopEmailProvider.lastVars.link
# For manual without hook: SELECT tokenHash, expiresAt FROM "EmailVerificationToken" WHERE userId=:id ORDER BY createdAt DESC LIMIT 1;
# But raw is not in DB (only hash). In dev/test with EMAIL_PROVIDER=noop, logs contain hashPrefix only.
# For E2E `supertest` capture via NoopEmailProvider.lastVars.link (recommended):
# GET link = https://app.example.com/verify-email?token=<raw64>&email=ali@example.com

# 3) Verify via GET link (public)
RAW=<paste 64hex from Noop log or test hook>
curl "http://localhost:3000/auth/verify-email?token=$RAW&email=ali@example.com"
# 200 { "verified": true, "emailVerified": true }

# 4) Second use same raw → 400
curl "http://localhost:3000/auth/verify-email?token=$RAW&email=ali@example.com"
# 400 { statusCode:400, message:"Invalid or expired verification token" }

# 5) Concurrent single-winner proof (manual with two curls in parallel same RAW fresh token):
# Create fresh register with other email, capture RAW2, then:
# (curl "http://localhost:3000/auth/verify-email?token=$RAW2&email=b@example.com" & curl "http://localhost:3000/auth/verify-email?token=$RAW2&email=b@example.com" & wait)
# Expect one 200 one 400.

psql -h localhost -U postgres -d mini_ecommerce -c "SELECT email, emailVerified, marketingOptIn FROM \"user\" WHERE email='ali@example.com';"
psql -h localhost -U postgres -d mini_ecommerce -c "SELECT tokenHash, expiresAt, usedAt FROM \"EmailVerificationToken\" ORDER BY createdAt DESC LIMIT 2;"
```

### 5.2 Resend → cooldown + anti-enum (P1)

```bash
curl -X POST http://localhost:3000/auth/resend-verification -H "Content-Type: application/json" -d '{"email":"ali2@example.com"}'
# 200 { message:"If an account exists, a verification email has been sent." } even if !found

# For unverified user within cooldown:
curl -X POST http://localhost:3000/auth/resend-verification -H "Content-Type: application/json" -d '{"email":"unverified@example.com"}'
curl -X POST http://localhost:3000/auth/resend-verification -H "Content-Type: application/json" -d '{"email":"unverified@example.com"}'
# Second within 60s -> 429 Retry-After: 60

# For already verified user (clarified):
curl -X POST http://localhost:3000/auth/resend-verification -H "Content-Type: application/json" -d '{"email":"ali@example.com"}'
# 200 { message:"Email already verified" } (no token/email, since ali now verified)

redis-cli get "resend:cooldown:unverified@example.com" # TTL 60
redis-cli flushdb # to reset rate-limit during manual
```

### 5.3 Forgot-password wired (P2)

```bash
curl -X POST http://localhost:3000/auth/forgot-password -H "Content-Type: application/json" -d '{"email":"ali@example.com"}'
# 200 anti-enum, worker logs [NoopEmail] verify/reset? Actually template reset, capture via Noop:
# SELECT * FROM "PasswordResetToken" ORDER BY createdAt DESC LIMIT 1; # hash only
# For manual: use test hook or NoopEmailProvider.lastVars.link containing reset link with raw

# Validate + reset (reuse existing:
curl -X POST http://localhost:3000/auth/validate-reset-token -H "Content-Type: application/json" -d '{"email":"ali@example.com","token":"<raw64>"}'
# 200 {valid:true}
curl -X POST http://localhost:3000/auth/reset-password -H "Content-Type: application/json" -d '{"email":"ali@example.com","token":"<raw64>","newPassword":"NewPass123"}'
# 200 + User.tokenVersion++ + PasswordResetToken usedAt
```

### 5.4 Admin sales bulk + preferences (P2)

```bash
# Create admin user (or promote via db):
psql -h localhost -U postgres -d mini_ecommerce -c "UPDATE \"user\" SET role='Admin' WHERE email='ali@example.com';"

# Login as Admin to get JWT
TOKEN_ADMIN=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"ali@example.com","password":"Password123"}' | jq -r .accessToken)

# Seed 10 users: 5 marketingOptIn true+verified true, rest mixed (via register + verify + PATCH preferences):
# Quick seed via admin sales does not require manual — use scenario in tests.

# Update preferences as regular user:
TOKEN_USER=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"user@example.com","password":"pass"}' | jq -r .accessToken)
curl -X PATCH http://localhost:3000/users/me/preferences -H "Authorization: Bearer $TOKEN_USER" -H "Content-Type: application/json" -d '{"marketingOptIn":true}'
# 200 { marketingOptIn:true }

curl http://localhost:3000/users/me -H "Authorization: Bearer $TOKEN_USER" | jq . # includes marketingOptIn, emailVerified

# Enqueue sales bulk (Admin):
curl -X POST http://localhost:3000/admin/notifications/sales \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H "Content-Type: application/json" \
  -d '{"title":"Sale -20%","body":"All products this week"}'
# 202 { jobId:"<campaignId>", message:"Bulk notification enqueued" }

# Check worker audit:
psql -h localhost -U postgres -d mini_ecommerce -c "SELECT template, count(*) FROM notification_log WHERE template='sales' GROUP BY template;"
redis-cli keys "notification:send:sales:*" | wc -l
# Replay same campaignId manually (queue add with same jobId) → no new sends when Redis SET NX 0
```

### 5.5 New product fan-out

```bash
# Create product as Admin (GraphQL) or via REST if exists, worker auto fans to marketingOptIn+verified:
# POST /admin/products or GraphQL mutation createProduct -> after commit queue.add notification.new_product
```

## 6. Rate-limit proofs

```bash
# Verify 429 before FOR UPDATE (0 transaction) is visible via test spy, manual:
for i in $(seq 1 11); do curl -s -i "http://localhost:3000/auth/verify-email?token=invalid&email=a@b.com" | head -1; done
# 11th -> 429

# With Redis down (docker stop redis): request still 200 or 400 (fail-open), logs: Logger.warn RateLimit Redis fail-open
```

## 7. Tests

```bash
npm run lint
npm run test -- --runInBand # unit 15+ (verify single-use, resend invalidate, sales gate, Noop capture, preferences)
npm run test -- --runInBand src/modules/auth/test/verify.integration.spec.ts # real PG FOR UPDATE concurrent 200+400, FLUSHDB dedup
npm run test:e2e -- test/app.e2e-spec.ts # supertest register→verify→forgot→reset→login→checkout + admin sales 10 users + replay 0
npm run build
```

## 8. DB Checks (PostgreSQL)

```bash
psql -h localhost -U postgres -d mini_ecommerce
# EmailVerificationToken
\d "EmailVerificationToken"
SELECT conname, contype FROM pg_constraint WHERE conrelid='\"EmailVerificationToken\"'::regclass;
EXPLAIN SELECT * FROM "EmailVerificationToken" WHERE "tokenHash"='abc' AND "userId"='uuid';
# User
SELECT email, emailVerified, marketingOptIn FROM "user" LIMIT 5;
# NotificationLog
\d notification_log
SELECT template, "userId", "sentAt" FROM notification_log ORDER BY "sentAt" DESC LIMIT 10;
SELECT WHERE marketingOptIn=true AND emailVerified=true;
```

## 9. Nightly Purge (7d)

```bash
psql -c "DELETE FROM \"EmailVerificationToken\" WHERE (\"usedAt\" IS NOT NULL AND \"usedAt\" < NOW() - INTERVAL '7 days') OR (\"expiresAt\" < NOW() - INTERVAL '7 days');"
```

## 10. Troubleshooting

- `401` on `/admin/notifications/sales` → ensure `Admin` role `UPDATE "user" SET role='Admin'`.
- `429` after manual loops → `redis-cli flushdb` or wait `3600`.
- No email log → `EMAIL_PROVIDER=noop` `EMAIL_FROM` not needed for Noop; check `Logger.log [NoopEmail]`.
- `400 Invalid token` → `token` must be `64` hex `0-9a-f` with matching `email`; `hash=sha256(raw)`.
- `GET /users/me` missing `marketingOptIn` → migration not run `npm run migration:run`.
