# Architecture — Email Service + Dual-Channel Notifications (Phase 18)

**Spec**: `specs/014-email-service/spec.md` | **ADR**: `../decisions/ADR-email-service.md` (+ fold: `../decisions/0013-verification-token-fold.md`) | **Branch**: `014-email-service`

Phase 16 made `emailVerified` + `PasswordResetToken` but never sent mail. Phase 18 wires sending and adds user-visible notifications, reusing `NotificationsModule` (no new top-level module).

> Fold note (2026-10-04, ADR-0013): the verification token no longer lives in
> an `email_verification_token` table. `User` carries the single live token
> (`emailVerificationTokenHash/ExpiresAt/UsedAt`); issue overwrites, verify
> consumes under user-row `FOR UPDATE`; history and the 7d purge are gone.
> Read the flows below with "token row" replaced by "user columns".

## Flows

```text
Register → COMMIT User(emailVerified false)
  → requestEmailVerification (fire-and-forget, never blocks 201):
     tx overwrite User verification columns {sha256(raw), 24h, usedAt NULL}
     → after commit emit email.verification_requested {userId,email,rawToken}
  → Worker @EventPattern: SET NX dedup → lookup real email → EmailChannel.send
     + SystemChannel persist → Notification/Delivery DELIVERED → gateway broadcast → ACK

Verify: GET|POST /auth/verify-email → user-row FOR UPDATE by email
  → valid: usedAt=NOW() + emailVerified=true → 200 {verified:true}
  → used/expired/wrong → 400 (concurrent same raw → 200+400)

Resend: POST /auth/resend-verification → 60s cooldown SET NX EX 60 → 429 before tx
  → !found → 200 anti-enum → verified → 200 distinct → else overwrite live hash + new 24h + emit

Reset: POST /auth/forgot-password (existing 15m token) → after commit emit
  auth.password_reset_requested → worker sends reset link (FRONTEND_URL)

Sales: POST /admin/notifications/sales @Auth(Admin) → 202 {jobId}
  → BullMQ 'notification' sendBulk {campaignId ephemeral, title, body}
  → processor pages Users WHERE marketingOptIn && emailOptIn && emailVerified (500 cursor)
  → per-user SET NX 24h → dispatcher channels → send → Notification/Delivery + Log
  → replay same campaignId → 0 new (SET NX 0)
```

## Delivery states (US6)

```text
PENDING → PROCESSING → SENT_TO_MQ (broker accepted, 0 Notification rows)
  → CONSUMED (worker FOR UPDATE + dedup + ACK) → DELIVERED (all channels ok)
  → FAILED retained (requeue → PENDING)
Per-channel (eventId,channel): PENDING → SENT → DELIVERED → FAILED (3 attempts)
READ separate: isRead false→true via PATCH :id/read | read-all
```

`OutboxEvent` = MQ-leg truth (`OutboxModule`); `Notification/Delivery` = user-leg truth (`NotificationsModule`); Redis = dedup/rate-limit only (fail-open).

## Channels (US7, Strategy + Factory)

`src/modules/notifications/channels/` — `NotificationChannel` interface, `SystemChannel` (persist + WS `notification:new` via `NotificationsGateway` namespace `notifications`, JWT `user:<sub>` rooms, offline stays `SENT`), `EmailChannel` (`EMAIL_PROVIDER`: `smtp`=`nodemailer`, default `noop`), `NotificationChannelFactory.create()` (`sms`→400, future-proof), `NotificationDispatcher.dispatch()` (runtime prefs resolution).

History: `GET /notifications` + `unread-count` + `PATCH :id/read` + `read-all` (owner-scoped, `FOR UPDATE`, Admin `?userId=`).

## Config

`EMAIL_PROVIDER=noop|smtp`, `EMAIL_FROM`, `SMTP_HOST/PORT/USER/PASS/SECURE`, `EMAIL_VERIFICATION_TTL=24h`, `EMAIL_RESET_TTL=15m`, `EMAIL_SALES_BATCH_SIZE=500`, `FRONTEND_URL`, `WS_AUTH`, `NOTIFICATION_HISTORY_PAGE_SIZE=20` — all via `ConfigService`, never hardcoded. Retention: verification columns need no purge (overwritten live value); `NotificationLog` indefinite.
