# Research — Phase 18 Email Service

**Branch**: `014-email-service` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Decisions — D1-D8

### D1: Token hashing — sha256(raw) vs store raw vs bcrypt hash

- **Decision**: Store `sha256` hex of `raw 64 hex (=32 bytes random)` via `crypto.createHash('sha256').update(raw).digest('hex')` (`tokenHash varchar(255) @Index`), never store `raw`, never log `raw` (log `hashPrefix=tokenHash.slice(0,6)` only via `Logger`). `raw = crypto.randomBytes(32).toString('hex')`.
- **Rationale**: Same pattern as `PasswordResetToken` Phase 16 + `RefreshToken` Phase 17 (already audited `specs/005-auth-upgrades`, `specs/013-refresh-token`); `sha256` is cheap `p95 <1ms`, deterministic for lookup `SELECT ... WHERE tokenHash=hash FOR UPDATE`, collision `2^-256` negligible handled via one retry on `23505`. `bcrypt` would be slower and non-deterministic for index lookup.
- **Alternatives considered**: `bcrypt(tokenHash)` — rejected: requires `compare` not index `FOR UPDATE`. Store raw — rejected: leak on DB dump/logs.

### D2: TTL — EmailVerificationToken 24h vs reuse RESET 15m

- **Decision**: `EmailVerificationToken` `expiresAt = now + EMAIL_VERIFICATION_TTL=24h` (`parseTtlMs` supports `s/m/h/d`, invalid → `24h` + `Logger.warn`), `PasswordResetToken` stays `15m` (`EMAIL_RESET_TTL/RESET_TOKEN_TTL`). `CHECK expiresAt > createdAt` both.
- **Rationale**: Clarification Q1 (kickoff) — user needs longer to click link than to reset password; avoids churn `400 expired` on 15m for verify. `24h` matches plan §18.2 `EmailVerificationToken` TTL.
- **Alternatives considered**: `15m` both — rejected: too short for email click. `48h` — rejected: longer window for `token` reuse if mailbox compromised.

### D3: EmailProvider — abstraction Noop vs Smtp vs SES/SendGrid for V1

- **Decision**: Define `interface EmailProvider { send(to, subject, template:'verify'|'reset'|'sales'|'new_product', vars: Record<string,any>): Promise<{messageId:string}> }` + impl `NoopEmailProvider` (dev/test `Logger.log [NoopEmail] to=* template=* vars link=*` + `return {messageId:'noop-'+uuid}` capture via `lastVars`) + `SmtpEmailProvider` (`nodemailer` `createTransport({host:SMTP_HOST, port:SMTP_PORT, auth:{user:SMTP_USER,pass:SMTP_PASS}, secure:SMTP_SECURE})` via `ConfigService`). Selection `EMAIL_PROVIDER` (`ConfigService` default `noop`, prod `smtp`, future `ses|sendgrid` wrappers keep Noop contract). `EMAIL_FROM="Mini E-Commerce <noreply@example.com>"` injected.
- **Rationale**: Same pattern as `WhatsApp OTP` Phase 16 `Noop` for CI (no live SMTP keys in CI, unit capture `lastLink`), real `Smtp` behind same `ConfigService` switch; `ses`/`sendgrid` are optional same interface. `Noop` allows `register→verify` E2E `supertest` without network (`NoopEmailProvider.lastVars.link` extraction + `AuthService.lastVerificationToken` test hook).
- **Alternatives considered**: Direct `nodemailer` without interface — rejected: not mockable. `SES` mandatory V1 — rejected: requires AWS creds in dev.

### D4: Async transport — publish after commit RabbitMQ vs BullMQ for verify/reset vs bulk

- **Decision**: All `email.*` events published **only after** `DataSource.transaction` commit (constitution async rule, `grep -c client.emit 0 inside manager`). Reuse existing infra per plan §18.1-18.3: `RabbitMQ client.emit('email.verification_requested', {userId,email,rawToken,expiresAt})` OR `BullMQ queue.add('email.verify', {userId,email,rawToken})` outside transaction — either is acceptable, both after commit; author chose `BullMQ notification` queue for `verify/reset` + `sales/new_product` bulk (`notification.sendBulk` `attempts 3 backoff exponential 1s`). `VerificationToken` creation is inside `transaction` + `emit` after; worker handles `EmailProvider.send` + `NotificationLog` audit outside `FOR UPDATE`.
- **Rationale**: Plan §18.5 already allows either `RabbitMQ classic NOTIFICATION_SERVICE` or `BullMQ repeat` (same `REDIS_URL`/`RABBITMQ_URL` as `CacheModule`/`BullModule` Phase 5 `30s` `ExpirationProcessor`). Bulk `sales` naturally fits `BullMQ` pagination `500` `concurrency 5`; verify/reset transient Smtp `5xx` fits `attempts 3` `backoff 1s·2^n`. Keeping same infra avoids new client.
- **Alternatives considered**: Sync `await EmailProvider.send` inside transaction — rejected: blocks commit, rolls back on transient Smtp 5xx (violates constitution). In-transaction `client.emit` — rejected: event may fire before commit visibility.

### D5: Unverified login gate — Allow vs Block vs Limit scope

- **Decision**: **Allow** `POST /auth/login` (and `POST /auth/refresh`, `GET /auth/verify-email`) even if `User.emailVerified=false` (clarification 2026-09-23 **Allow unverified login**). `emailVerified` gate applies **only** to `sales`/`new_product` fan-out (`WHERE marketingOptIn=true AND emailVerified=true`), not to `login`/`checkout`/`order`. `POST /auth/refresh` still succeeds for unverified (Phase 17 `X-Email-Unverified` header remains warn-only).
- **Rationale**: Plan §18.6 explicitly lists verification gate for marketing only; blocking login would prevent `register→login→verify` E2E `supertest` from capturing `rawToken` via authenticated `GET /users/me`; hybrid `checkout requires verified` rejected for V1 simplicity (future `order` could gate if desired).
- **Alternatives considered**: Block `login 403 Email not verified` — rejected: breaks E2E until SMTP proven. Limit scope `checkout requires verified` — rejected: not in spec `SC-006` `no stock mutation` proof.

### D6: Resend for already verified — 200 anti-enum vs 400 vs 200 distinct

- **Decision**: `POST /auth/resend-verification {email}` for `emailVerified true` returns `200 {message:"Email already verified"}` **distinct** from anti-enum `200 {message:"If an account exists, a verification email has been sent."}` (clarification 2026-09-23 **200 already verified msg**). `!found` still anti-enum `200` same message (no `404`), no `EmailVerificationToken` row, `0` `EmailProvider.send`. Distinct message discloses verified state but improves UX for legitimate verified callers.
- **Rationale**: Clarification chosen `200 already verified msg` (not `400`) to keep `200` for both but distinguish verified (friendly) from unknown (anti-enum) — matches Phase 16 `forgot-password` already `200` but allows client to show “already verified” banner.
- **Alternatives considered**: `400 Already verified` — rejected: makes client error path. `200` same anti-enum message for verified — rejected: leaves caller unsure why click did nothing.

### D7: Bulk campaign storage — ephemeral job vs persistent sales_campaign table

- **Decision**: **Ephemeral job only** V1 — `POST /admin/notifications/sales` validates `title 1-200+body+productIds` then `BullMQ queue.add('notification.sendBulk', {campaignId: uuid(), template:'sales', subject:title, body, productIds}, {attempts:3 backoff …})` `202 {jobId}` no `sales_campaign` row; audit via `NotificationLog` per-user rows only (clarification 2026-09-23 **Ephemeral job only**).
- **Rationale**: Plan §18.2 explicitly says `V1: no Campaign table, just enqueue job with title/body`; adding a table would be extra migration + `Admin` list/history UI not required for SC-004 `10 users 5 gate`. Future `campaign` table can be added without breaking `NotificationLog` dedup key `campaignId`.
- **Alternatives considered**: Persistent `sales_campaign {id,title,body,createdBy,createdAt}` — rejected: not needed for E2E `202→worker NotificationLog` proof, defer to Dashboard Phase 20.

### D8: Bulk idempotency — Redis-only SET NX 24h vs Redis+DB UNIQUE fallback

- **Decision**: **Redis-only** `SET NX notification:send:<template>:<campaignId|productId>:<userId> EX 86400` before `EmailProvider.send` (clarification 2026-09-23 **Redis only**). When `CACHE_MANAGER` `throw ECONNREFUSED` → `Logger.warn Redis fail-open for notification dedup` + allow send (duplicate on retry tolerated, logged, no DB `@Unique` fallback). `NotificationLog` has no `@Unique(userId,template,campaignId)` — replay can insert duplicate `NotificationLog` row but `SET NX` primary prevents duplicate `send` when Redis healthy.
- **Rationale**: Redis-only matches plan §18.6 bulk idempotency `notification:send:* SET NX 24h`; DB unique fallback would require composite partial index + catch `23505` handling `0` `send` — rejected for V1 simplicity; fail-open tolerating one duplicate on `ECONNREFUSED` is acceptable per `Edge Cases` (bulk per-user failure does not abort pagination, retry can re-send that user).
- **Alternatives considered**: Redis + `NotificationLog @Unique` — rejected: adds constraint complexity and would `500` on retry without Redis. Redis-only is simpler and already satisfies SC-004 `replay same campaignId → 0 new` when Redis healthy.

## Resolved NEEDS CLARIFICATION

- Technical Context had **0** `NEEDS CLARIFICATION` (all decisions derived from `spec.md` clarifications: 5 kickoff + 5 session 2026-09-23 `Allow unverified / 7d purge / ephemeral / 200 verified msg / Redis only`).
- FR retention `7d purge` for `EmailVerificationToken` (`DELETE WHERE usedAt< NOW()-7d OR expiresAt< NOW()-7d` nightly) vs `NotificationLog` indefinite kept — resolved via clarification (D2+D7).
- TTL `24h verify` vs `15m reset` resolved (D2).
- Provider switch `EMAIL_PROVIDER noop default` resolved (D3).

## Decisions — D9-D12 (2026-10-01 delivery-state + dual-channel)

### D9: Delivery-state model — extend OutboxStatus vs separate Delivery row vs both

- **Decision**: **Both**: extend `OutboxStatus` (`SENT` → `SENT_TO_MQ` + new `CONSUMED` + `DELIVERED`, `FAILED` terminal) for the MQ-leg AND add separate `NotificationDelivery` per `(eventId, channel)` for the user-leg. `OutboxEvent` stays MQ-leg truth (`OutboxModule`); deliveries are user-leg truth (`NotificationsModule`); no cross-repo.
- **Rationale**: Status-only extension cannot express "system delivered but email failed" per channel; delivery-row-only leaves `OutboxEvent.SENT` ambiguous for operators. Both together answer MQ-accepted vs consumed vs per-channel-sent with PG truth on both legs (constitution I), Redis still only `SET NX` dedup.
- **Alternatives considered**: Status-only (no delivery table) — rejected: per-channel retry/observability lost. Delivery-row-only (keep `SENT` meaning) — rejected: `SENT` stays ambiguous. Callback `PATCH` from consumer to `OutboxModule` — rejected: breaks module boundaries; consumer updates via its own `DataSource` `FOR UPDATE OutboxEvent` without importing `OutboxService`.

### D10: Notification vs NotificationLog — merge vs keep both

- **Decision**: **Keep both**: `Notification` (inbox, one row per `(eventId,channel)`, `isRead/readAt`) + `NotificationLog` (provider audit, append-only per-send row, existing entity unchanged).
- **Rationale**: Audit must record retries (many rows per event); inbox must stay one row for history/unread correctness (`@Unique(eventId,channel)` + `orIgnore` on duplicate consume). Merge would either lose retry audit or break unread counts.
- **Alternatives considered**: Merge into `Notification` with `attempts` — rejected: unread-count and history paging polluted by retry rows. Merge into `NotificationLog` with `isRead` — rejected: `eventId @Unique` audit row is per-send, not per-user-inbox for dual-channel (needs two rows with different channels).

### D11: Realtime transport — WebSocket gateway vs SSE vs polling only

- **Decision**: `@WebSocketGateway({namespace:'notifications'})` with JWT `handleConnection` → room `user:<sub>`, events `notification:new` + `notification:read`; offline users fall back to `GET /notifications` fetch (PG truth, no Redis offline queue).
- **Rationale**: Reuse NestJS WS (no new infra), matches `SYSTEM` channel semantics (emit-ack → `DELIVERED`, offline → stays `SENT`). SSE rejected: needs separate HTTP stream handling per user; FCM rejected: external keys in V1.
- **Alternatives considered**: Polling-only (no WS) — rejected: user requirement for realtime. Redis offline queue — rejected: PG history fetch already covers offline without extra truth store.

### D12: Channel pattern — Strategy + Factory vs switch vs per-channel services

- **Decision**: `NotificationChannel` interface + `SystemChannel`/`EmailChannel` + `NotificationChannelFactory.create(channel)` + `NotificationDispatcher.dispatch` (runtime opt-in resolution), all in existing `src/modules/notifications/` (no new top-level module).
- **Rationale**: Runtime `marketingOptIn/emailOptIn` resolution per event type (`verify/reset` both always; sales gated; order.* email iff `emailOptIn`) needs a single dispatch point; factory makes `sms|push` additive (new strategy class, no caller change). Switch-in-worker rejected: scatters opt-in logic across handlers.
- **Alternatives considered**: New `src/modules/notification/` singular module (old plan) — rejected: `src/modules/notifications/` already exists with worker/provider/log; reuse it. Per-channel microservices — rejected: modular monolith (constitution II).

- Technical Context had **0** `NEEDS CLARIFICATION` (all decisions derived from `spec.md` clarifications: 5 kickoff + 5 session 2026-09-23 `Allow unverified / 7d purge / ephemeral / 200 verified msg / Redis only`).
- FR retention `7d purge` for `EmailVerificationToken` (`DELETE WHERE usedAt< NOW()-7d OR expiresAt< NOW()-7d` nightly) vs `NotificationLog` indefinite kept — resolved via clarification (D2+D7).
- TTL `24h verify` vs `15m reset` resolved (D2).
- Provider switch `EMAIL_PROVIDER noop default` resolved (D3).
