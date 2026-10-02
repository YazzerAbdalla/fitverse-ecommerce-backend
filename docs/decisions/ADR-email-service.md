# ADR: Email Service — Verify/Reset + Dual-Channel Notifications (Phase 18)

**Date**: 2026-10-01 | **Status**: Accepted | **Spec**: `specs/014-email-service/spec.md` | **Plan**: `specs/014-email-service/plan.md` | **Branch**: `014-email-service`

## Context

Phase 16 left `emailVerified=false` with no path to `true` (`register` sent nothing, `forgot-password` only `Logger.log + TODO`). Phase 11/12 built transactional outbox (`PENDING→PROCESSING→SENT/FAILED`, `FOR UPDATE SKIP LOCKED`, `SET NX notification:processed:<eventId>`) but `SENT` meant "accepted by RabbitMQ transport" with no visibility into consumed vs delivered-to-user. Requirement before Phase 14 testing: wire verification/reset email, add opt-in sales/news bulk, and distinguish MQ-accepted vs consumed vs user-delivered — reusing the existing `NotificationsModule` via runtime Strategy + Factory, with WebSocket system channel + history/unread.

## Decision

- **Tokens**: `EmailVerificationToken` (PG truth, `sha256(raw 64hex)`, `expiresAt=now+24h`, single-use `usedAt`, `FOR UPDATE` single-winner, `400` on reuse/expiry) mirrors `PasswordResetToken` (15m) pattern. `register` calls `requestEmailVerification` fire-and-forget after commit; `resend-verification` anti-enum `200` + `60s cooldown SET NX EX 60` + dual rate buckets; `forgot-password` now emits `auth.password_reset_requested` after commit (existing token logic untouched).
- **Delivery states**: `OutboxStatus` extended `PENDING→PROCESSING→SENT_TO_MQ→CONSUMED→DELIVERED` (`SENT` kept as legacy alias; new `consumedAt`). `SENT_TO_MQ` = broker accepted (publisher, token-checked). `CONSUMED` = worker `FOR UPDATE OutboxEvent` + dedup passed + manual ACK. Per-channel `NotificationDelivery (eventId,channel)` rows `PENDING→SENT→DELIVERED→FAILED` (3 attempts, retained). User-visible `Notification` rows (`@Unique(eventId,channel)`, `isRead/readAt`) back history; `NotificationLog` kept as provider audit. `PATCH /admin/outbox/:id/requeue` still `FAILED→PENDING`.
- **Channels**: `NotificationChannel {send}` Strategy + `NotificationChannelFactory.create()` with V1 `SystemChannel` (persist `Notification` + `NotificationsGateway` `notification:new` emit; offline stays `SENT`) and `EmailChannel` (wraps `EMAIL_PROVIDER`). `NotificationDispatcher.dispatch` resolves at runtime: `verify/reset` always both; `sales/new_product` both iff `marketingOptIn && emailOptIn && emailVerified` else system-only; `order.*` both iff `emailOptIn`. Extensible to `sms|push` without caller change.
- **Prefs**: `User.marketingOptIn` default `false` (register checkbox) + `User.emailOptIn` default `true`; `PATCH /users/me/preferences` either-or; `GET /users/me` exposes both + `emailVerified`. History: `GET /notifications` (owner paginated + filters, Admin `?userId=`) + `unread-count` + `PATCH :id/read` (idempotent, `FOR UPDATE` + owner `403`) + `read-all`.
- **Dedup**: Redis `SET NX` primary (`notification:processed:<eventId>`, `notification:send:<template>:<campaign>:<userId> 24h`, `resend:cooldown 60s`), fail-open with `Logger.warn`; PG `@Unique` as backstop (`orIgnore`). Decommissioned `EventVerificationConsumer` (shared patterns with the real worker → double consume race on placeholder emails); real `NotificationWorker` owns all `@EventPattern`s.
- **Provider**: `EMAIL_PROVIDER` factory (`smtp` via `nodemailer` + `SMTP_*`/`EMAIL_FROM`, else `Noop` with `lastSend` capture for tests). Retention: `EmailVerificationToken` 7d purge (`AuthService.purgeExpiredVerificationTokens`, nightly caller = ops concern); `NotificationLog` indefinite.

## Alternatives Considered

- JWT as verification token — **rejected**: cannot invalidate on resend without version nuke; opaque+hash matches reset/refresh precedent.
- Blocking login when unverified — **rejected**: breaks `register→login→verify` onboarding; gate applies to marketing only.
- Persistent `sales_campaign` table — **rejected**: ephemeral `campaignId` in job data + `NotificationLog` audit suffices for V1.
- `SENT` reuse for delivered — **rejected**: conflates broker-accept with user-delivery; new states are additive, never rewrite history.
- New top-level notification module (singular) — **rejected**: extended existing `NotificationsModule` (plural) in place.

## Consequences

- `register→verify→resend→forgot→reset→sales→prefs→history/unread` works end-to-end; concurrent same-token `→ 200+400`; replay `→ 0` new sends; offline WS user stays `SENT` until fetch.
- Extra PG rows per event (1 `Notification` + N deliveries) — bounded, indexed `(userId,createdAt)`, `(userId,isRead)`.
- `SmtpEmailProvider` needs live `SMTP_*` in prod; dev/test stay `Noop` (no network in CI).

## Verification

- `npm run build` pass; new unit specs (auth 31, dispatcher 8, outbox-status 8, history controller 7, notification.service 9, users prefs 6) pass; integration/e2e skip cleanly without PG (docker daemon down at implementation time — real-PG proofs deferred to CI with infra up).
