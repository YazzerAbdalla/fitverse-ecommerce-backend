# Data Model — Phase 18 Email Service

**Branch**: `014-email-service` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Entities

### 1. EmailVerificationToken (NEW, PostgreSQL authoritative, not Redis)

Represents a single-use 24h hash for `GET|POST /auth/verify-email`. Mirrors `PasswordResetToken` pattern (`sha256` raw 64 hex) but separate table + `24h` TTL.

```text
EmailVerificationToken
----------------------
id         uuid PK @PrimaryGeneratedColumn('uuid')
userId     uuid FK → User.id ON DELETE CASCADE @Index @ManyToOne
tokenHash  varchar(255) @Index  -- sha256 hex of raw (crypto.randomBytes(32).toString('hex') 64 chars => sha256 64 hex)
expiresAt  timestamptz NOT NULL  -- now + EMAIL_VERIFICATION_TTL 24h (parseTtlMs s/m/h/d, invalid→24h+warn)  @Check("expiresAt" > "createdAt") @Index
usedAt     timestamptz nullable -- NULL=active, set NOW() on verify success OR on resend invalidation (SET usedAt=NOW() WHERE userId AND usedAt IS NULL)  -- single-use
createdAt  timestamptz @CreateDateColumn @Index
```

- **Indexes**: `IDX_email_verification_token_userId`, `IDX_email_verification_token_tokenHash`, `IDX_email_verification_token_expiresAt`, composite `IDX_email_verification_token_userId_expiresAt` (`userId, expiresAt`). `EXPLAIN` for `SELECT ... WHERE tokenHash=:hash AND userId=:id FOR UPDATE` should hit `tokenHash` index.
- **Constraints**: `@Check('"expiresAt" > "createdAt"')`; `@Check('"tokenHash" IS NOT NULL')` via `@Column(nullable:false)`; FK `ON DELETE CASCADE` (User deleted → tokens removed, consistent with `PasswordResetToken`); **no** partial unique `UQ(tokenHash) WHERE revokedAt IS NULL` needed V1 — multiple per user allowed but only one active (`resend` invalidates priors via `usedAt=NOW()`); collision `23505` on `tokenHash` unique (if added later) → retry one `crypto.randomBytes` else `500` `Logger.error` without `raw`.
- **Generation**: `raw = crypto.randomBytes(32).toString('hex')` (`64` chars `0-9a-f`), `hash = createHash('sha256').update(raw).digest('hex')`, `expiresAt = now + 24h` via `Date.now()+parseTtlMs(EMAIL_VERIFICATION_TTL)`. `raw` never persisted, never logged (`hashPrefix=hash.slice(0,6)` only).
- **Lifecycle**: `register → requestEmailVerification(email)` after commit fires `UPDATE usedAt=NOW() WHERE userId AND usedAt IS NULL` + `INSERT {userId, tokenHash, expiresAt}` + after commit `emit email.verification_requested {userId,email,raw,expiresAt}` → `EmailWorker` `send verify`. `resend →` same invalidate+insert new `raw2` + emit new. `verify → SELECT ... FOR UPDATE` → `if !found || usedAt IS NOT NULL || expiresAt<=NOW() →400` else `SET usedAt=NOW() + UPDATE User.emailVerified=true` commit → `200 {verified:true}` + optional `emit auth.email_verified`. Concurrent `Promise.all([verify,verify])` same `raw` → `FOR UPDATE` single-winner `200+400`.
- **Retention**: Nightly purge `DELETE FROM "EmailVerificationToken" WHERE (usedAt IS NOT NULL AND usedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days')` (clarification 7d purge); `NotificationLog` indefinite. `BullMQ` repeat or `pg_cron` handled later.

### 2. User (ALTERED, existing Phase 16 + 17 base + new column)

```text
User
----
id                uuid PK @PrimaryGeneratedColumn('uuid')
firstName         varchar
lastName          varchar
email             varchar @Unique @Index  -- existing
password          varchar nullable        -- existing, bcrypt 10
role              enum UserRoles          -- existing (User/Admin) default User
phoneNumber       varchar nullable @Index
phoneVerified     boolean default false
googleId          varchar nullable @Index
provider          enum local|google
tokenVersion      int default 0           -- Phase 16, incremented on password reset + Phase 17 logout-all
passwordChangedAt timestamptz nullable
emailVerified     boolean default false   -- Phase 16, already present
marketingOptIn    boolean NOT NULL DEFAULT false @Column({default:false})  -- NEW Phase 18, GDPR-like opt-in for sales/news
emailOptIn        boolean NOT NULL DEFAULT true @Column({default:true})   -- NEW 2026-10-01, email-channel gate (verify/reset bypass)
```

- **Migration**: `ALTER TABLE "user" ADD COLUMN "marketingOptIn" boolean NOT NULL DEFAULT false` (no index needed for boolean scan; partial index `WHERE marketingOptIn IS TRUE` future if scale proven). Existing rows default `false` (already verified users stay opt-out until `PATCH`).
- **Migration (2026-10-01)**: `ALTER TABLE "user" ADD COLUMN "emailOptIn" boolean NOT NULL DEFAULT true` (email-channel gate; existing rows default `true` so current transactional mail keeps flowing).
- **Validation**: `RegisterDto` add `marketingOptIn?: boolean @IsOptional @IsBoolean` + `emailOptIn?: boolean @IsOptional @IsBoolean` (whitelist). `UpdatePreferencesDto { marketingOptIn?: boolean @IsOptional @IsBoolean, emailOptIn?: boolean @IsOptional @IsBoolean }` (either-or update).
- **Indexes**: Existing `email`, `phoneNumber`, `googleId`; no new index on `marketingOptIn`.
- **Gate**: Bulk `WHERE marketingOptIn=true AND emailVerified=true` for `sales/new_product` fan-out (FR-010/011). `verify/reset` always sent regardless of this flag. Email-channel resolution additionally requires `emailOptIn=true` except `verify/reset` which bypass both flags.

### 3b. Notification (NEW 2026-10-01, user-leg truth for history — kept separate from NotificationLog audit)

User-visible inbox row. One row per `(eventId, channel)` so a dual-channel event yields two rows (system + email) with independent read state.

```text
Notification
------------
id          uuid PK @PrimaryGeneratedColumn('uuid')
userId      uuid FK → User.id ON DELETE CASCADE @Index
eventId     uuid @Index  -- links OutboxEvent.id (no hard FK so FAILED-retained rows survive business deletes)
channel     enum NotificationChannel {SYSTEM, EMAIL} @Index
type        varchar @Index  -- 'verify'|'reset'|'sales'|'new_product'|'order.created'|'order.completed'|'order.cancelled'|'reservation.expired'
title       varchar
body        text
data        jsonb  -- {orderId, productId, link, campaignId, ...} PII-minimal
status      enum NotificationStatus {PENDING, SENT, DELIVERED, FAILED} default PENDING
isRead      boolean NOT NULL DEFAULT false
readAt      timestamptz nullable
sentAt      timestamptz @CreateDateColumn
deliveredAt timestamptz nullable
```

- **Indexes**: `IDX_notification_userId`, `IDX_notification_eventId`, `IDX_notification_channel`, `IDX_notification_type`, composite `IDX_notification_userId_createdAt (userId, createdAt DESC)` (history paging), composite `IDX_notification_userId_isRead (userId, isRead)` (unread-count), `@Unique(['eventId','channel'])` (`UQ_notification_eventId_channel` — duplicate consume → `orIgnore`, `0` new rows).
- **Decision (2026-10-01)**: keep `NotificationLog` (provider send audit, append-only per-send row) AND add `Notification` (inbox, one row per `(eventId,channel)` with read state). Merge rejected: audit must record retries (many rows), inbox must stay one row.
- **Lifecycle**: consumer upsert `PENDING` → channel send accepted → `SENT` (persisted) → ack/`messageId` → `DELIVERED`; offline system user stays `SENT` until fetch. `isRead/readAt` set only by `PATCH :id/read|read-all` (user behavior, never by worker).

### 3c. NotificationDelivery (NEW 2026-10-01, per-channel delivery leg owned by NotificationsModule)

```text
NotificationDelivery
--------------------
id          uuid PK @PrimaryGeneratedColumn('uuid')
eventId     uuid @Index  -- links OutboxEvent.id (no hard FK)
channel     enum NotificationChannel {SYSTEM, EMAIL}
status      enum NotificationStatus {PENDING, SENT, DELIVERED, FAILED} default PENDING
attempts    int default 0 CHECK >=0
messageId   varchar nullable  -- EmailProvider response or WS ack id
nextRetryAt timestamptz NOT NULL default NOW()
deliveredAt timestamptz nullable
```

- **Constraints**: `@Unique(['eventId','channel'])` (`UQ_notification_delivery_eventId_channel`); `@Check('"attempts" >= 0')`.
- **Lifecycle**: upserted `PENDING` when consumer resolves channels → `SENT` after persist/emit attempt → `DELIVERED` on ack/`messageId` → `FAILED` terminal after `3` channel attempts (retained, per-channel requeue; never rolls back `CONSUMED`).

### 3d. OutboxStatus extension (MQ-leg truth stays in OutboxModule, 2026-10-01)

`OutboxStatus` gains `CONSUMED` + `DELIVERED`; `SENT` is renamed `SENT_TO_MQ` (backward-compat alias kept in code, rename via new migration — never edit committed migrations). New column `consumedAt timestamptz nullable` on `outbox_event`.

```text
PENDING (business commit, OutboxService INSERT)
  → PROCESSING (publisher FOR UPDATE SKIP LOCKED claim + processingToken)
  → SENT_TO_MQ (client.emit resolved = broker accepted; sentAt=NOW(); 0 Notification rows)
  → CONSUMED (worker @EventPattern + SET NX passed + FOR UPDATE OutboxEvent; consumedAt=NOW(); manual ACK after commit)
  → DELIVERED (all resolved channel deliveries DELIVERED)
  → FAILED (terminal retained from any leg; PATCH /admin/outbox/:id/requeue → PENDING attempts=0)
```

- **Ownership**: publisher writes to `SENT_TO_MQ` only; consumer writes `CONSUMED`/`DELIVERED`. `Notification.isRead/readAt` is NOT a delivery state.

### 3. NotificationLog (NEW, audit + idempotency observation, not authoritative for business)

```text
NotificationLog
---------------
id         uuid PK @PrimaryGeneratedColumn('uuid')
userId     uuid FK → User.id ON DELETE CASCADE @Index
template   varchar @Index  -- 'verify' | 'reset' | 'sales' | 'new_product'
subject    varchar         -- e.g., "Verify your email", "Reset your password", "Sale -20%", "New product: <name>"
productId  uuid nullable FK → Product.id ON DELETE SET NULL @Index
orderId    uuid nullable FK → Order.id ON DELETE SET NULL @Index
provider   varchar         -- 'noop'|'smtp'|'ses'|'sendgrid' (from ConfigService EMAIL_PROVIDER)
messageId  varchar nullable -- provider response e.g., 'noop-<uuid>' or Smtp <msgId>
sentAt     timestamptz @CreateDateColumn @Index
```

- **Indexes**: `IDX_notification_log_userId`, `IDX_notification_log_template`, `IDX_notification_log_productId`, `IDX_notification_log_orderId`, `IDX_notification_log_eventId`, composite `IDX_notification_log_userId_sentAt`, `IDX_notification_log_template_sentAt`.
- **Dedup role**: `eventId @Unique` doubles as PG backstop for consume dedup (`orIgnore` on duplicate consume → `0` new rows; see research D8). `NotificationLog` was missing from every migration until backfilled by `1755900000008-CreateNotificationLog` (entity predated its table).
- **Writes**: Inside `NotificationWorker`/`EmailWorker` **after** `EmailProvider.send` succeeds, via `EntityManager.save` per batch (never inside `verifyEmail FOR UPDATE`). `provider` logs `hashPrefix` only for `verify/reset` if needed.
- **Constraints**: FK `ON DELETE CASCADE` for `userId`, `ON DELETE SET NULL` for `productId/orderId` (product deleted → log remains `productId NULL`); no `@Unique(userId, template, campaignId)` V1 because dedup is Redis-only (clarification); replay without Redis may insert second `NotificationLog` row but `SET NX` primary avoids second `send` when Redis healthy.
- **Retention**: Indefinite (audit), no purge V1. Scale >10k users uses BullMQ batching `EMAIL_SALES_BATCH_SIZE 500`.

### 4. No sales_campaign table V1 (ephemeral campaignId)

- Clarification 2026-09-23: No persistent `sales_campaign {id,title,body,createdBy}` table. `POST /admin/notifications/sales` creates `campaignId=uuid()` ephemeral in `BullMQ job.data` `{campaignId, template:'sales', subject:title, body, productIds}`.
- Dedup key uses ephemeral `campaignId`: `notification:send:sales:<campaignId>:<userId> EX 86400`. Replay with same `campaignId` (manual retry with same jobId) → `SET NX 0` skips. New `campaignId` → new send even with same title (intended).

### Relationships

```text
User 1──* EmailVerificationToken  (userId FK CASCADE)
User 1──* NotificationLog         (userId FK CASCADE)
User 1──* Notification            (userId FK CASCADE)
User 1──* PasswordResetToken      (existing)
User 1──* RefreshToken            (Phase 17)
NotificationLog *──? Product (productId SET NULL)
NotificationLog *──? Order   (orderId SET NULL)
OutboxEvent 1──* NotificationDelivery (eventId logical link, no FK)
OutboxEvent 1──* Notification       (eventId logical link, no FK)
```

### Validation Rules (from Requirements)

- `EmailVerificationToken`: `tokenHash` `@IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/)` on hash (after sha256), `expiresAt @Check > createdAt` enforced DB + service `expiresAt > NOW()` check, `usedAt nullable`, `userId` FK exists.
- `User.marketingOptIn`: `@IsBoolean` via `RegisterDto` optional + `UpdatePreferencesDto` optional.
- `User.emailOptIn`: `@IsBoolean` via `RegisterDto` optional + `UpdatePreferencesDto` optional (default `true`); either-or update (at least one flag per `PATCH`).
- `Notification.channel`: `@IsEnum(['SYSTEM','EMAIL'])`; `Notification.type`: `@IsIn([...8 types])`; `NotificationDelivery` `@Unique(eventId,channel)` enforced DB + `orIgnore` on upsert.
- `NotificationLog.template`: `@IsIn(['verify','reset','sales','new_product','test'])` via service validation (`test` = admin config probe, bypasses history).
- `VerifyEmailDto`: `email @IsEmail`, `token @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/)`.
- `ResendVerificationDto`: `email @IsEmail`.
- `CreateSalesNotificationDto`: `title @IsString @Length(1,200) @IsNotEmpty`, `body @IsString @IsNotEmpty`, `productIds?: @IsOptional @IsUUID('4', {each:true})`.
- `UpdatePreferencesDto`: `marketingOptIn @IsBoolean`.

### State Transitions

**EmailVerificationToken** (`usedAt` + `expiresAt` derived state, not enum):

```text
Inserted (usedAt NULL, expiresAt=now+24h)
  → Verified: SELECT ... FOR UPDATE found && usedAt NULL && expiresAt>NOW() → SET usedAt=NOW() + User.emailVerified=true → TERMINAL (second verify same hash =>400)
  → Invalidated by resend: resend arrival before verify → UPDATE SET usedAt=NOW() WHERE userId AND usedAt IS NULL (old) + INSERT new (old becomes TERMINAL even though not verified)
  → Expired: expiresAt<=NOW() without usedAt => SELECT finds but returns 400 (no state change, nightly purge 7d)
  → Purged: 7d after usedAt OR expiresAt
```

**User.emailVerified**: `false (default) → true` (via `verifyEmail` success, one-way, never back to `false` V1).

**User.marketingOptIn**: `false (default) ↔ true` via `PATCH /users/me/preferences {marketingOptIn}` `FOR UPDATE User` (bidirectional).

**User.emailOptIn**: `true (default) ↔ false` via same `PATCH` (bidirectional, either-or update).

**NotificationLog**: append-only, no transitions.

**OutboxEvent (extended 2026-10-01)**: `PENDING → PROCESSING → SENT_TO_MQ → CONSUMED → DELIVERED`, `FAILED` terminal from any leg (`requeue → PENDING`).

**Notification / NotificationDelivery**: `PENDING → SENT → DELIVERED`, `FAILED` terminal after 3 channel attempts (per-channel requeue, never rolls back `CONSUMED`).

**Notification.isRead**: `false → true` via `PATCH :id/read|read-all` only (user behavior, idempotent re-read `200`).

### Data Volume / Scale Assumptions

- `EmailVerificationToken` rows: ~1 per register + ~1 per resend before verify. 10k users ~10-15k rows before purge; `7d` purge keeps bounded. Bulk `sales` does not create tokens.
- `NotificationLog` rows: 1 per `verify`/`reset` send (tiny) + `|Users eligible|` per `sales/new_product` bulk. 10k eligible × 100 campaigns = 1M rows (ok with `(userId,sentAt)` index, no purge V1).
- Paging: `EMAIL_SALES_BATCH_SIZE 500` cursor `ORDER BY id LIMIT 500` (verified + opt-in filter).
- Redis dedup: 1 `SET NX` per eligible user per bulk (`10k/500 *5 concurrency` ~20 batches).
