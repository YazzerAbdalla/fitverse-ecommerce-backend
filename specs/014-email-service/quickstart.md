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
EMAIL_PROVIDER=noop              # noop|smtp|resend (default noop; smtp+resend select nodemailer SMTP, resend targets Resend relay)
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
WS_AUTH=true
NOTIFICATION_HISTORY_PAGE_SIZE=20
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

There is no `migration:run` npm script, and `npx typeorm migration:run -d src/data-source.ts`
fails in this repo (`module: nodenext` ESM loading). Compile the needed migration(s) to
CommonJS and run them with an explicit migrations array instead:

```bash
npx tsc src/migration/1755900000006-NotificationDeliveryAndHistory.ts \
  --module commonjs --target es2021 --outDir ./migration-tmp --skipLibCheck

node -e "const { DataSource } = require('typeorm'); require('dotenv').config(); const ds = new DataSource({ type: 'postgres', host: process.env.POSTGRES_HOST || '127.0.0.1', port: parseInt(process.env.POSTGRES_PORT || '5432', 10), username: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DATABASE || 'ecommerce', migrations: [require('./migration-tmp/1755900000006-NotificationDeliveryAndHistory.js').NotificationDeliveryAndHistory1755900000006] }); (async () => { await ds.initialize(); const ran = await ds.runMigrations({ transaction: 'each' }); console.log('RAN:', ran.map(m => m.name).join(', ') || '(none pending)'); await ds.destroy(); })();"
rm -rf migration-tmp
```

Notes:
- Migrations already recorded in the `migrations` table are skipped; `transaction: 'each'` isolates failures per migration.
- `1755900000005-CreateRefreshToken` is unexecutable (references `"User"` instead of `"user"`) — record it as faked (`INSERT INTO migrations ("timestamp", name) VALUES (1755900000005, 'CreateRefreshToken1755900000005')`) and let `1755900000007` create the table correctly. Never edit a committed migration — fix forward.
- Creates: `email_verification_token` + `User.emailOptIn/marketingOptIn` + `notification`/`notification_delivery`/`notification_log` + `outbox_event` (+`consumedAt`) + enum widening (`synchronize:false`).

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
# For manual without hook: SELECT tokenHash, expiresAt FROM "email_verification_token" WHERE "userId"=:id ORDER BY "createdAt" DESC LIMIT 1;
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

psql -h localhost -U postgres -d ecommerce -c "SELECT email, \"emailVerified\", \"marketingOptIn\", \"emailOptIn\" FROM \"user\" WHERE email='ali@example.com';"
psql -h localhost -U postgres -d ecommerce -c "SELECT \"tokenHash\", \"expiresAt\", \"usedAt\" FROM \"email_verification_token\" ORDER BY \"createdAt\" DESC LIMIT 2;"
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
# SELECT * FROM "password_reset_token" ORDER BY "createdAt" DESC LIMIT 1; # hash only
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
psql -h localhost -U postgres -d ecommerce -c "UPDATE \"user\" SET role='Admin' WHERE email='ali@example.com';"

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
psql -h localhost -U postgres -d ecommerce -c "SELECT template, count(*) FROM notification_log WHERE template='sales' GROUP BY template;"
redis-cli keys "notification:send:sales:*" | wc -l
# Replay same campaignId manually (queue add with same jobId) → no new sends when Redis SET NX 0
```

### 5.5 New product fan-out

```bash
# Create product as Admin (GraphQL) or via REST if exists, worker auto fans to marketingOptIn+verified:
# POST /admin/products or GraphQL mutation createProduct -> after commit queue.add notification.new_product
```

### 5.6 History, unread + WebSocket realtime (US6/US7, 2026-10-01)

```bash
# History (owner paginated, filters optional):
curl "http://localhost:3000/notifications?page=1&limit=20" -H "Authorization: Bearer $TOKEN_USER" | jq .
# 200 { data:[{id, channel, type, title, isRead:false, ...}], meta:{totalItems, ...} }
curl "http://localhost:3000/notifications?isRead=false&channel=EMAIL" -H "Authorization: Bearer $TOKEN_USER" | jq .

# Unread count → mark read → read-all:
curl http://localhost:3000/notifications/unread-count -H "Authorization: Bearer $TOKEN_USER"
# 200 { "unreadCount": 2 }
NID=$(curl -s "http://localhost:3000/notifications?isRead=false" -H "Authorization: Bearer $TOKEN_USER" | jq -r .data[0].id)
curl -X PATCH http://localhost:3000/notifications/$NID/read -H "Authorization: Bearer $TOKEN_USER"
# 200 { id, isRead:true, readAt:"..." } (re-read same id → 200 idempotent)
curl -X PATCH http://localhost:3000/notifications/read-all -H "Authorization: Bearer $TOKEN_USER"
# 200 { "updated": 1 }
# Other user's id → 403; no JWT → 401

# Delivery-state proof (operator):
psql -h localhost -U postgres -d ecommerce -c "SELECT id, \"eventType\", status, \"sentAt\", \"consumedAt\" FROM outbox_event ORDER BY \"createdAt\" DESC LIMIT 5;"
# PENDING → SENT_TO_MQ (publisher) → CONSUMED (worker) → DELIVERED (channels)
psql -h localhost -U postgres -d ecommerce -c "SELECT \"eventId\", channel, status, attempts FROM notification_delivery ORDER BY \"eventId\" LIMIT 10;"

# WebSocket realtime (SYSTEM channel, online path):
# Connect first (JWT via query param), then trigger a dispatch (e.g. sales bulk above):
npx wscat -c "ws://localhost:3000/notifications?token=$TOKEN_USER"
# Within 2s of dispatch expect:
# {"event":"notification:new","data":{"id":"...","type":"sales","title":"Sale -20%","channel":"SYSTEM"}}
# Offline client simply misses the emit — row stays SENT and appears in next GET /notifications fetch.
```

### 5.7 SMTP config probe (test-email)

```bash
# Admin-only config probe (bypasses outbox/dedup/history). Response echoes the
# active provider so noop vs real SMTP is unambiguous:
curl -X POST http://localhost:3000/admin/notifications/test-email \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H "Content-Type: application/json" \
  -d '{"to":"you@example.com","subject":"SMTP test","body":"config probe"}'
# 200 { "to":"you@example.com", "provider":"resend", "messageId":"<...>", "delivered":true }
# provider noop → only logged, nothing delivered. provider smtp|resend → real SMTP send.
# NOTE: Resend onboarding@resend.dev sender only delivers to the account-owner
# inbox unless a domain is verified — probe your own address first.
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
npm run test:e2e # supertest register→verify→forgot→reset→login→checkout + admin sales + replay 0
npm run build
```

## 8. DB Checks (PostgreSQL)

```bash
psql -h localhost -U postgres -d ecommerce
# EmailVerificationToken
\d email_verification_token
SELECT conname, contype FROM pg_constraint WHERE conrelid='"email_verification_token"'::regclass;
EXPLAIN SELECT * FROM "email_verification_token" WHERE "tokenHash"='abc' AND "userId"='uuid';
# User
SELECT email, "emailVerified", "marketingOptIn", "emailOptIn" FROM "user" LIMIT 5;
# NotificationLog
\d notification_log
SELECT template, "userId", "sentAt" FROM notification_log ORDER BY "sentAt" DESC LIMIT 10;
SELECT email, "emailVerified" FROM "user" WHERE "marketingOptIn"=true AND "emailOptIn"=true AND "emailVerified"=true LIMIT 5;
```

## 9. Nightly Purge (7d)

```bash
psql -c "DELETE FROM \"email_verification_token\" WHERE (\"usedAt\" IS NOT NULL AND \"usedAt\" < NOW() - INTERVAL '7 days') OR (\"expiresAt\" < NOW() - INTERVAL '7 days');"
# Or via service: AuthService.purgeExpiredVerificationTokens() (nightly caller = ops concern)
```

## 10. Troubleshooting

- `401` on `/admin/notifications/sales` → ensure `Admin` role `UPDATE "user" SET role='Admin'`.
- `429` after manual loops → `redis-cli flushdb` or wait `3600`.
- No email log → `EMAIL_PROVIDER=noop` `EMAIL_FROM` not needed for Noop; check `Logger.log [NoopEmail]`.
- `400 Invalid token` → `token` must be `64` hex `0-9a-f` with matching `email`; `hash=sha256(raw)`.
- `GET /users/me` missing `marketingOptIn` → migrations not applied (see §3; there is no `migration:run` script).
- `relation "outbox_event" does not exist` in poll loop → migrations never ran on this DB; baseline old ones + run pending per §3.
- `relation "refresh_token" does not exist` on login → pre-0009 schema; run `1755900000009-RenameRefreshTokenLowercase` (§3).
- `lockTables.join is not a function` → old `setLock(..., {skipLocked:true})` form; use `.setLock('pessimistic_write').setOnLocked('skip_locked')` on typeorm 1.1.
- `NOTIFICATION_SERVICE not available` every poll → fixed by `@Global MessagingModule`; if it returns, the app runs pre-fix code — rebuild + restart.
