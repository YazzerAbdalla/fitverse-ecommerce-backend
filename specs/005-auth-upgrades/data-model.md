# Data Model: Auth Upgrades (Phase 16)

**Feature**: `005-auth-upgrades` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## Entities

### User (ALTER — no new table)

Existing `User` (`src/modules/users/entity/user.entity.ts`) — `@Entity()` `@Index(['email'])` today.

**Proposed alterations** (migration `17xxxxx-AuthUpgradesUserAndResetToken`):

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` PK `PrimaryGeneratedColumn('uuid')` | existing | unchanged |
| `firstName` | `varchar` | `NOT NULL` existing | unchanged |
| `lastName` | `varchar` | `NOT NULL` existing | unchanged |
| `email` | `varchar` | `@Index` existing → **add** `@Unique(['email'])` + DB `UNIQUE(email)` (`UQ_user_email`) | was only indexed; now unique |
| `role` | enum `UserRoles` | existing `default UserRoles.User` | unchanged |
| `password` | `varchar` | existing `NOT NULL` → **ALTER** `nullable: true` (`DROP NOT NULL`) | pure-OAuth users have null; local users still require bcrypt |
| `phoneNumber` | `varchar` nullable | `@Column({ nullable:true })`, `@Index`, `@Unique` partial `WHERE phoneNumber IS NOT NULL` (`UQ_user_phoneNumber`) | E.164 `^\+[1-9]\d{1,14}$`, validated in DTO |
| `phoneVerified` | `boolean` | `@Column({ default:false })` | set true on `purpose=verify_phone` success or `purpose=login` if user exists |
| `googleId` | `varchar` nullable | `@Column({ nullable:true })`, `@Unique` partial `WHERE googleId IS NOT NULL` (`UQ_user_googleId`) | from Google profile.id |
| `provider` | enum `('local','google')` | `@Column({ type:'enum', enum:['local','google'], default:'local' })` + `@Check provider IN ('local','google')` | `local` for existing rows (migration default) |
| `passwordChangedAt` | `timestamptz` nullable | `@Column({ type:'timestamptz', nullable:true })`, `@Index` | set `NOW()` on `reset-password` success; JWT `iat < passwordChangedAt` → `401` per Q3 |
| `emailVerified` | `boolean` | `@Column({ default:false })` optional | future use, not blocking V1 (plan notes) |

Migrations: `ALTER COLUMN password DROP NOT NULL`, `ADD COLUMN phoneNumber/googlId/provider/passwordChangedAt/phoneVerified/emailVerified`, `ADD CONSTRAINT UQ_user_email UNIQUE(email)`, `CREATE UNIQUE INDEX UQ_user_googleId WHERE googleId IS NOT NULL`, `CREATE UNIQUE INDEX UQ_user_phoneNumber WHERE phoneNumber IS NOT NULL`, `CHECK(provider)`.

**Relations**: `OneToMany Order`, `OneToOne Cart` — unchanged.

**Validation**: `UserRegisterDto` stays `password MinLength 4` (existing) but `ResetPasswordDto newPassword MinLength 8 MaxLength 72`, `phoneNumber @Matches(/^\+[1-9]\d{1,14}$/)`, `provider @IsEnum`.

### PasswordResetToken (NEW)

Opague recovery credential. Reuses `Research D1-D3`.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` PK | `PrimaryGeneratedColumn('uuid')` | |
| `userId` | `uuid` FK → `User.id` | `ON DELETE CASCADE`, `@Index`, `ManyToOne(User)` `@JoinColumn` | owns token |
| `user` | `ManyToOne` | relation | |
| `tokenHash` | `varchar(255)` | `NOT NULL`, `@Index` (`IDX_tokenHash`) | `sha256` hex 64 chars; no raw token stored |
| `expiresAt` | `timestamptz` | `NOT NULL`, `@Index`, `@Check('"expiresAt" > "createdAt"')` | `now + RESET_TOKEN_TTL (15m)` |
| `usedAt` | `timestamptz` nullable | `NULL` until single-use, set `NOW()` on `reset-password` success | second use → `400` |
| `createdAt` | `timestamptz` | `@CreateDateColumn()` | |

Indexes: `@Index(['userId'])`, `@Index(['tokenHash'])`, `@Index(['expiresAt'])`, `@Index(['userId','expiresAt'])` for cleanup/query.

**Lifecycle**: `INSERT` on `forgot-password` (after invalidating prior active tokens `usedAt IS NULL AND expiresAt > NOW()`), single-use `usedAt=NOW()` on `reset-password` inside `FOR UPDATE` tx. Multiple rows allowed, only one active. Cleanup: nightly purge `expiresAt < NOW() - 7d` optional (not critical path per plan).

**File**: `src/modules/auth/entities/password-reset-token.entity.ts`

### OtpVerification (NEW — audit + fallback)

Ephemeral phone verification. Research D5 + Q4 fallback.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` PK | `PrimaryGeneratedColumn('uuid')` | |
| `phoneNumber` | `varchar` | `NOT NULL`, `@Index` | E.164, owns OTP |
| `userId` | `uuid` nullable FK → `User.id` | `ON DELETE SET NULL`, `@Index` nullable | links if user exists |
| `user` | `ManyToOne` nullable | `JoinColumn` | |
| `purpose` | enum `('login','verify_phone')` V1 | `@Column({ type:'enum', enum:['login','verify_phone'], default:'login' })` `@Check` | `reset_password` + email purposes deferred (§16.8) |
| `codeHash` | `varchar` | `NOT NULL` | `sha256` of 6-digit OTP |
| `expiresAt` | `timestamptz` | `NOT NULL`, `@Index`, `CHECK expiresAt > createdAt` | `now + OTP_TTL (5m)` |
| `attempts` | `int` | `default 0`, `@Check('"attempts" <= 3')` | increment on each `verify` |
| `verifiedAt` | `timestamptz` nullable | `NULL` until success, set `NOW()` on verify success | |
| `createdAt` | `timestamptz` | `@CreateDateColumn()` | |

Indexes: `@Index(['phoneNumber'])`, `@Index(['expiresAt'])`, `@Index(['phoneNumber','createdAt'])` per plan.

**Lifecycle**: Created on `POST /auth/otp/request` (alongside Redis `SET ... EX 300`). On `POST /auth/otp/verify`: check Redis first; if Redis down or key missing, fallback to latest `OtpVerification` row for phone where `expiresAt > NOW()` and `verifiedAt IS NULL`, verify `sha256(otp) === codeHash`, `attempts < OTP_MAX_ATTEMPTS`, increment `attempts`, set `verifiedAt` on success or delete/invalidate on limits. Redis delete on success/3 fails + mark `verifiedAt`.

**File**: `src/modules/auth/entities/otp-verification.entity.ts`

### WhatsApp OTP (Redis — not DB entity but part of model)

Transient `key = otp:whatsapp:<E.164>` value `{ tokenHash: string, attempts: number, createdAt: number, expiresAt: number, purpose: string }` `TTL 300s`. Resend cooldown via `SET NX EX 60` per phone. Not authoritative for inventory/order; OTP-specific TTL exception (constitution Additional Constraints) documented in ADR.

## Relationships Diagram (text)

```text
User 1──* PasswordResetToken (FK userId CASCADE)
User 1──* OtpVerification (FK userId SET NULL, phone-scoped; latest row used for fallback)
User phoneNumber (E.164) 1──* OtpVerification + Redis key otp:whatsapp:<phone>
```

## Validation & State Transitions

- **PasswordResetToken**: `expiresAt > createdAt` CHECK; hash lookup only; `usedAt` once; invalid/expired/used → `400`
- **OtpVerification**: `expiresAt > createdAt` CHECK; `attempts <= 3` CHECK; `purpose` enum check; TTL enforced by Redis + service `expiresAt > now`; 4th attempt → delete + `400/429`
- **User**: `password` nullable CHECK (pure OAuth allowed); `provider` CHECK; partial uniques ensure `null` duplicates allowed
- **JWT revocation**: `User.passwordChangedAt` — `JwtStrategy.validate` compares `payload.iat` (seconds) vs `passwordChangedAt` (ms); if `iat*1000 < passwordChangedAt` → throw `UnauthorizedException`

## Migrations

1. `17xxxxx-AuthUpgradesUserAndResetToken` — alter `User` (new columns, nullables, uniques, checks) + create `PasswordResetToken` table + indexes/FKs + `passwordChangedAt`
2. `17xxxxx-AddOtpAndGoogleFields` — create `OtpVerification` table + indexes/FKs (can be merged into #1 if desired; keep `synchronize:false`, never edit committed migration)

`data-source.ts` already lists `migrations: ['src/migration/**/*.ts']`; run `npm run migration:run` (or `typeorm migration:run`) after DDL.
