# Quickstart: Auth Upgrades (Phase 16)

**Feature**: `005-auth-upgrades` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Prereqs

- Node 20, npm, Docker Desktop
- `docker-compose up -d` (postgres 17, redis 8, rabbitmq 4)
- `.env` populated (never commit secrets):

```env
JWT_SECRET=dev-secret-not-real
JWT_EXPIRES_IN=15m
RESET_TOKEN_TTL=15m
OTP_TTL=5m
OTP_MAX_ATTEMPTS=3
OTP_RESEND_COOLDOWN=60s
WHATSAPP_PROVIDER=noop
WHATSAPP_FROM_NUMBER=+14155238886
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
FRONTEND_URL=http://localhost:3000
```

## Build / Lint / Test

```bash
npm run build
npm run lint
npm run test -- --runInBand                 # unit (mocked EntityManager, Redis, WhatsApp, Google)
npm run test:e2e                           # uses test/jest-e2e.json + supertest (3 auth E2E flows)
```

Integration needs **real PostgreSQL** (docker); run `--runInBand` to avoid PG lock races.

## Manual Verification

### Forgot → Validate → Reset → Login (with JWT revocation)

```bash
# register
curl -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d '{"firstName":"Ali","lastName":"Test","email":"ali2@example.com","password":"OldPass123!"}'

# forgot (always 200 anti-enum)
curl -X POST http://localhost:3000/auth/forgot-password -H "Content-Type: application/json" -d '{"email":"ali2@example.com"}'
# check DB (rawToken captured via test hook or query tokenHash)
# SELECT "tokenHash","expiresAt","usedAt" FROM "PasswordResetToken" WHERE "userId"=(SELECT id FROM "User" WHERE email='ali2@example.com') ORDER BY "createdAt" DESC LIMIT 1;

# validate
curl -X POST http://localhost:3000/auth/validate-reset-token -H "Content-Type: application/json" -d '{"email":"ali2@example.com","token":"<rawHex64>"}'

# reset
curl -X POST http://localhost:3000/auth/reset-password -H "Content-Type: application/json" -d '{"email":"ali2@example.com","token":"<rawHex64>","newPassword":"NewStrong123!"}'

# old JWT should now fail (passwordChangedAt revocation per Q3)
# curl -H "Authorization: Bearer <oldAccessToken>" http://localhost:3000/cart  # expect 401

# new login 200, old password 401
curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"ali2@example.com","password":"NewStrong123!"}'
curl -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"ali2@example.com","password":"OldPass123!"}' # 401
# reuse same token → 400
curl -X POST http://localhost:3000/auth/reset-password -H "Content-Type: application/json" -d '{"email":"ali2@example.com","token":"<rawHex64>","newPassword":"Another123!"}' # 400
```

### Concurrent token race (SC-003)

Run two `POST /auth/reset-password` with same raw token in parallel (e.g. `&` or k6) → one `200` one `400`. Verify `SELECT usedAt` non-null and only one password update.

### WhatsApp OTP (login choice)

```bash
# request (Noop captures OTP in logs)
curl -X POST http://localhost:3000/auth/otp/request -H "Content-Type: application/json" -d '{"phoneNumber":"+201012345678","purpose":"login"}'
# verify within 300s (OTP from Noop log or DB: SELECT "codeHash","expiresAt" FROM "OtpVerification" ORDER BY "createdAt" DESC LIMIT 1; then find raw in provider mock)
curl -X POST http://localhost:3000/auth/otp/verify -H "Content-Type: application/json" -d '{"phoneNumber":"+201012345678","otp":"123456","purpose":"login"}'
# → 200 { accessToken } , GET /cart with JWT 200
# wrong OTP 4 times → 4th is 429 and requires resend; resend within 60s → 429 cooldown

# Redis down fallback (Q4): stop redis `docker stop redis`, then otp/request + verify still succeed via PG fallback (check DB row updated)
```

Login choice (Q2): `POST /auth/login` (password) and `POST /auth/otp/request|verify` (phone) both appear in Swagger `/api`.

### Google OAuth (mocked)

```bash
# initiate → 302
curl -i http://localhost:3000/auth/google  # Location: https://accounts.google.com/...
# callback mocked in tests: GET /auth/google/callback with passport mock profile → 200 { accessToken }
# auto-link verified email (Q1): register local alice@gmail.com with password, then google callback with same verified email → same user returned, googleId set

# link authenticated
# curl -H "Authorization: Bearer <jwt>" http://localhost:3000/auth/google/link  # 302 then callback → 200 { message: Google linked }
```

### DB constraints

```sql
-- duplicate email → 409
INSERT INTO "User" (email) VALUES ('ali2@example.com');
-- duplicate googleId where not null → 409
-- expiresAt <= createdAt → CHECK violation
```

### Swagger

Open `http://localhost:3000/api` — verify 7 new endpoints + DTO examples + `300` OTP `expiresIn` + rate-limit `429` schema.

