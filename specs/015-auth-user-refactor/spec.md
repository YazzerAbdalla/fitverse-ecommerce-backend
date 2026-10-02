# Feature Specification: Auth + Users Refactor (RP-AUTH)

**Feature Branch**: `015-auth-user-refactor`
**Created**: 2026-10-02
**Status**: Draft
**Input**: User description: "let's refactor using the refactor plan and let's start with auth + user modules - check the refactor plan to check the rules"
**Plan reference**: `docs/REFACTOR_PLAN.md` §RP-AUTH (Rev. 2), §§3–5, §10 rules, §11 DoD, Appendix B decisions

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Identical sign-in and session behavior after refactor (Priority: P1)

An existing client (web app, mobile app, or API consumer) registers, logs in,
refreshes tokens, logs out, recovers passwords, and verifies email exactly as
before. No request, response, status code, cookie, header, or retry behavior
they rely on changes.

**Why this priority**: Auth is on every request path and has the highest blast
radius in the refactor plan (Risk: High). Behavior preservation is the load-bearing
guarantee; every structural change in this spec is gated on it.

**Independent Test**: Can be fully tested by running the existing auth contract
matrix (register/login/refresh/logout/logout-all/forgot/reset/verify/resend/Google/OTP-501)
against the refactored code and diffing status codes, bodies (minus fresh token
values), cookies, and headers against the pre-refactor baseline. Delivers a
safer codebase with zero consumer migration.

**Acceptance Scenarios**:

1. **Given** a new user with valid registration details, **When** they register,
   **Then** they receive the same success response as before and a verification
   token is created for later email delivery without blocking the response.
2. **Given** a registered user with correct credentials, **When** they log in,
   **Then** they receive a short-lived access credential plus a single-use
   long-lived refresh credential (body and secure cookie), identical in shape
   and lifetime to before.
3. **Given** a valid refresh credential, **When** it is used once,
   **Then** a new rotated pair is issued and the old credential is permanently
   invalidated; **When** the old credential is reused, **Then** access is denied
   and all credentials for that user are revoked (theft protection), as before.
4. **Given** an authenticated user, **When** they log out of one session,
   **Then** only that session ends (repeat logout still succeeds); **When** they
   log out of all sessions or reset their password, **Then** every session ends
   and old credentials are rejected, as before.
5. **Given** a user who forgot their password, **When** they request a reset,
   **Then** they always get the same neutral success message whether or not the
   account exists; **When** they use a valid single-use reset token,
   **Then** the password changes; second use or expired tokens are rejected.
6. **Given** a new user, **When** they verify email with a valid single-use link,
   **Then** the account is marked verified; expired or reused links are rejected;
   resend requests respect the cooldown and never reveal account existence.

---

### User Story 2 - Single ownership of user data (Priority: P1)

A maintainer fixing a user-related bug opens the codebase and finds exactly one
place that writes user records. Auth flows orchestrate; they never bypass the
user boundary to write user rows directly.

**Why this priority**: Today the auth flow reaches past the users boundary to
write user rows directly (~3+ direct-access sites confirmed), violating the
plan's module-boundary invariant (TI-1). Every later phase (order, expiration,
notifications) consumes the authenticated-user shape, so this must be fixed
before those phases move.

**Independent Test**: Can be fully tested by static inspection (no direct user-row
writes outside the users boundary) plus the full auth matrix still passing.
Delivers one accountable owner for user invariants.

**Acceptance Scenarios**:

1. **Given** any auth flow that creates or mutates a user (register, password
   reset, Google link, phone verification flag), **When** it executes,
   **Then** the user-row write goes through the users boundary, never around it.
2. **Given** a code reviewer checking boundaries, **When** they search for
   cross-module user persistence, **Then** they find zero violations and the
   previously bypassed sites are covered by tests proving identical outcomes.

---

### User Story 3 - Explicit transaction and failure boundaries (Priority: P2)

A maintainer reading a token flow (refresh rotation, reset, verification) can
point to exactly one place that owns the all-or-nothing unit of work. Storage
helpers participate in that unit but never commit, roll back, or perform
network/input-output inside it. Failures outside the unit (email send, event
publish, cache write) never roll back committed business state.

**Why this priority**: Transaction-ownership inconsistency is the plan's
central correctness finding. Auth must demonstrate the fixed rule (use-case
owns the boundary; stores never commit/rollback) because order/expiration work
copies this pattern.

**Independent Test**: Can be fully tested by fault-injection (event/cache/mail
failure still leaves committed token/user state intact; partial token rotation
never persists) plus controller-level inspection showing no transaction or data
access in the HTTP layer. Delivers auditable, single-winner concurrency.

**Acceptance Scenarios**:

1. **Given** a refresh rotation in progress, **When** the process crashes
   between invalidating the old credential and issuing the new one,
   **Then** the whole unit rolls back (no half-rotated state) and retry
   semantics match the pre-refactor baseline.
2. **Given** two concurrent uses of the same single-use credential,
   **When** both race, **Then** exactly one succeeds and the other triggers
   theft protection, with the database row locked during the decision as before.
3. **Given** a committed password reset or verification, **When** the follow-up
   notification publish fails, **Then** the committed state stands and the
   failure is logged/retried through the existing async path, never by rolling
   back the user-visible success.

---

### User Story 4 - Clean seams with no hidden behavior change (Priority: P3)

A maintainer extending tokens, rate limits, or notifications finds small,
named, intention-revealing units (token hashing, duration parsing, clock,
idempotency keys, event publishing) instead of copy-pasted inline logic, and
the HTTP layer owns all HTTP concerns (status codes, cookies, rate-limit
responses) while the domain layer owns none.

**Why this priority**: The auth flow is ~1267 lines with triple-duplicated
hashing/TTL/cooldown logic and HTTP responses built inside business logic.
Extraction is justified only at proven responsibility seams (Rule of Three),
never on size alone — per plan rules SG-1/MF-1.

**Independent Test**: Can be fully tested by unit matrices per extracted helper
(identical outputs for identical inputs) plus unchanged controller suites.
Delivers extensibility without a framework.

**Acceptance Scenarios**:

1. **Given** any token hash or expiry computation, **When** computed before and
   after the refactor, **Then** outputs are byte-identical for the same inputs.
2. **Given** a rate-limited auth endpoint under load, **When** the limit is hit,
   **Then** the same throttled response and headers are returned as before, and
   no throttled request ever holds a database lock.
3. **Given** a reviewer checking for framework sprawl, **When** they inspect new
   abstractions, **Then** each one cites at least three proven call sites and no
   generic base/repository/state-machine abstraction exists.

---

### Edge Cases

- Concurrent refresh with the same credential → exactly one success + theft
  revoke-all; concurrent verify-email with the same token → one success, one
  rejection; concurrent reset with the same token → one success, one rejection.
- Cap on active sessions per user (currently 5, least-recently-created revoked
  first) is preserved byte-for-byte, including which session gets evicted.
- Global session nuke (logout-all / password reset increments the user's token
  version) invalidates both access and refresh credentials atomically.
- Resend-verification cooldown (currently ~60s) and per-address/per-network
  rate buckets are preserved, including fail-open behavior when the limiter is
  unreachable (allow + warn, never 500).
- Anti-enumeration: unknown emails on forgot-password/resend return the same
  neutral success as known emails; no timing or message oracle is introduced.
- Google sign-in with an unverified provider email is rejected; verified-email
  auto-link vs create behavior is unchanged.
- OTP endpoints remain explicitly unimplemented (501) and isolated; shared
  storage helpers may be reused but OTP behavior does not change.
- Registration response keeps its current shape and must not leak password
  material (pinned by test per clarified decision D3).
- Cache/broker outages (Redis/RabbitMQ down) preserve current fail-open
  semantics; PostgreSQL remains the authority for tokens, users, and revocation.
- `strateges/` directory typo and duplicated strategy files: renamed/moved only
  with reachability evidence and zero import-behavior change (path aliases and
  DI registrations updated atomically).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST preserve every observable auth/user contract
  (routes, status codes, response bodies, cookies, headers, event payloads,
  queue names, retry counts, TTLs) byte-for-byte except where an approved
  B/S-class change explicitly documents the delta.
- **FR-002**: System MUST route all user-row writes through the users boundary;
  auth flows MUST NOT write user rows via direct repository/manager access
  (plan invariant TI-1). Reads needed for authentication go through the same
  boundary or an explicitly documented read-only seam. The users API itself is
  extended, not redesigned: existing `UsersService` method names/signatures are
  kept (params added only where needed); token flows (refresh/verification/OTP)
  get separate store units rather than new user-surface methods.
- **FR-003**: System MUST give each multi-write token flow (refresh rotation +
  theft nuke, password reset + token invalidation, verification + flag set,
  resend + prior invalidation) exactly one owning transaction boundary in the
  use-case layer; storage helpers MUST accept the ambient transaction context
  and MUST never commit, roll back, or open nested transactions (TI-3/TX-1/TX-2).
- **FR-004**: System MUST keep controllers transaction-free and persistence-free
  (no `DataSource`/repository/`EntityManager` in controllers); all persistence
  moves into the use-case/storage layers (TI-1).
- **FR-005**: System MUST preserve single-use rotation with theft revoke-all,
  the per-user active-session cap with least-recent eviction, `FOR UPDATE`
  locking on token/refresh rows where the current code locks them, and the
  global token-version nuke (TI-8). Concurrency outcomes MUST be single-winner.
- **FR-006**: System MUST store and log only token hashes (never raw tokens),
  keep hashed-prefix logging, and keep expiry/single-use checks enforced both
  by the database constraints and the service checks (TI-8/SEC-1).
- **FR-007**: System MUST NOT build HTTP responses (rate-limit 429s, auth
  challenges) inside business logic; the HTTP layer MUST own status/body/header/
  cookie shaping, and throttling MUST execute before any database lock is taken.
- **FR-008**: System MUST NOT perform broker, cache, clock, or randomness
  input-output inside the owning transaction; side effects (event publish, mail
  trigger, cache write) happen after commit, and their failure MUST NOT roll
  back committed state (TI-4/TI-5).
- **FR-009**: System MUST scope this refactor to auth + users files only; it MUST
  NOT modify order, reservation, inventory, cart, products, outbox, or
  notifications behavior or files (per plan parallelization rule; auth is a
  self-contained track). The shared `RateLimitGuard` (exported via `AuthModule`
  to order/cart/products) is explicitly frozen in this spec: characterize its
  429/header/bucket behavior with pinned tests only; its table-driven
  restructure belongs to RP-CACHE-GUARD. Likewise the duplicated
  `EMAIL_PROVIDER` factory is left untouched here; single-factory
  consolidation belongs to RP-NOTIF.
- **FR-010**: System MUST consume shared helpers only where the plan's
  Rule-of-Three gate passes (≥3 proven sites, one responsibility): token hash,
  secure-token generation, duration parsing, clock, quantity/cooldown guards,
  owner checks, pagination, correlation/refresh extraction, error mapping.
  It MUST NOT introduce generic `Base/Generic/StateMachine/Repository` framework
  abstractions (MF-1). Two-site similarities are merged only if touched.
- **FR-011**: System MUST NOT convert silent-optional dependencies to required,
  remove fail-open behavior, or hard-fail on missing config without an explicit,
  tested decision record per item (OD-1/CF-1). Auth token configuration is
  delivered as a full typed `AuthTokenConfig` parsed once at startup (with
  startup-wiring tests); silent fallbacks are centralized with warn-once and
  values stay identical — no new hard-fail without separate approval.
- **FR-012**: System MUST land one full pre-split characterization baseline commit
  first (contract matrix + real-database single-winner proofs for refresh reuse,
  reset reuse, verify reuse, all green) before any structural split; every later
  diff is measured against it. Query-shape observations are recorded as signals,
  never as budgets (PQ-1).
- **FR-013**: System MUST document every touched class/method per project doc
  rules and add inline intent comments on complex conditions and
  stock/token/TTL/pagination/expiry formulas; it MUST NOT add new untyped
  holes without justification and MUST remove debug console output when
  touching those files.
- **FR-014**: System MUST resolve the two security-sensitive divergences and the
  registration-response question as decided in clarification (2026-10-02),
  each with regression tests:
  (a) S-1 dual JWT paths → **unify to JwtGuard as the sole path, adding the
  missing tokenVersion check there** (approved S-class change; revoked users
  are denied on every guarded route; both pre-paths pinned by tests first,
  then unified);
  (b) S-2 validate-vs-reset window → **validate stays an unlocked,
  non-authoritative UX pre-check, while resetPassword revalidates
  expiry/use/revocation inside its own transaction holding FOR UPDATE**,
  then consumes the token and changes the password atomically (approved;
  concurrent validate+reset regression tests prove the window is closed at
  the authority point);
  (c) D3 registration response → **keep the current shape returning the
  created user object, with a pinned test proving no password material is
  ever present** (no shape change).

### Key Entities

- **User account**: identity record (email, name, role, verification flags,
  token version for global revocation); single writer is the users boundary.
- **Refresh session**: opaque single-use credential record (hash, expiry,
  revocation marker); rotation invalidates old and issues new atomically.
- **Password-reset token**: short-lived single-use hash record with expiry and
  use marker; prior active tokens invalidated on new request.
- **Email-verification token**: longer-lived single-use hash record with expiry,
  use marker, and cooldown on resend.
- **Authenticated principal**: the stabilized identity shape consumed by guards
  and downstream phases (subject, email, role, token version) — unchanged by
  this refactor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All pre-existing auth/user happy paths (register, login, refresh,
  logout, logout-all, forgot, validate, reset, verify, resend, Google link,
  OTP-501) return identical status/body/cookie/header outcomes as the baseline
  within the existing test tolerances (zero consumer-visible changes).
- **SC-002**: Concurrent single-use-credential races (refresh reuse, reset reuse,
  verify reuse) each yield exactly one winner and the documented
  deny-and-revoke outcome for the loser in 100% of repeated trials.
- **SC-003**: Full verification gates pass on the touched scope: lint, build,
  unit tests, and end-to-end auth suites are green with no skipped
  previously-passing test and no new untyped hole without justification.
- **SC-004**: Static inspection shows zero cross-boundary user writes, zero
  transactions owned by controllers, zero broker/cache access inside owning
  transactions, and zero HTTP-response construction inside business logic.
- **SC-005**: Review of each new abstraction cites ≥3 proven call sites with
  identical-output unit matrices, and no generic base/framework abstraction
  is introduced.

## Clarifications

### Session 2026-10-02

- Q: RateLimitGuard scope in this auth+users refactor → A: Freeze guard — characterize only (pin 429/header/bucket behavior with tests, no structural change; table-driven split stays in RP-CACHE-GUARD).
- Q: UsersService write-API shape → A: Extend existing UsersService methods (keep names/signatures, add params only where needed); token flows get separate store units.
- Q: EMAIL_PROVIDER factory duplication → A: Leave for RP-NOTIF (no factory move now; single-EmailModule consolidation belongs to RP-NOTIF).
- Q: Config scope → A: Full typed AuthTokenConfig parsed once at startup in this spec (with startup-wiring tests; no hard-fail on missing values without separate approval — values centralized, identical).
- Q: Characterization baseline strategy → A: Full pre-split baseline commit first (contract matrix + single-winner races green) before any structural split; every later diff measured against it.

## Assumptions

- Prerequisites are consumed, not rebuilt here: Phase 0 baselines (correctness
  fix + security characterizations + hot-flow baselines) and shared primitives
  (CC-A pure helpers, CC-B app policies) exist or are vendored minimally with
  identical semantics; this spec does not re-specify them.
- Public API, events, queues, and schema are frozen; no migration is emitted in
  this spec. Any B/S-class delta requires a separate approved amendment.
- OTP (WhatsApp) stays explicitly unimplemented (501); only shared storage
  seams may be reused.
- The `strateges/` typo directory and duplicated strategy files are addressed
  only as path-hygiene with atomic import/DI updates, proven by a passing build.
- Verification uses the project's standard gates (lint/build/test/test:e2e on
  relevant suites plus real-database concurrency suites where locking is touched).
- Human approval is recorded (2026-10-02): S-1 unify to JwtGuard with
  tokenVersion check; S-2 validate read-only + authoritative recheck in reset;
  D3 keep registration shape with no-password-leak pin. These three are
  S-class deltas with regression tests; everything else stays R-only.
