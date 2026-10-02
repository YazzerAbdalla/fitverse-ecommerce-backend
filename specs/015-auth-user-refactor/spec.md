# Feature Specification: Auth + Users Refactor (RP-AUTH)

**Feature Branch**: `015-auth-user-refactor`
**Created**: 2026-10-02
**Status**: Draft
**Input**: User description: "let's refactor using the refactor plan and let's start with auth + user modules - check the refactor plan to check the rules"
**Plan reference**: `docs/REFACTOR_PLAN.md` §RP-AUTH (Rev. 2), §§3–5, §10 rules, §11 DoD, Appendix B decisions

> **Scope note**: this spec states WHAT (observable behavior + business rules).
> HOW (store layout, locking, guard internals, helper wiring) lives in
> `plan.md` (§Design Constraints) and `research.md` (D1–D8).

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
place that writes user records. Auth flows ask the users boundary to perform
writes; they never write user records themselves.

**Why this priority**: Today auth flows write user records directly in several
places. Every later phase (order, expiration, notifications) consumes the
authenticated-user shape, so single ownership must be fixed before those phases
move.

**Independent Test**: Can be fully tested by listing every user-record write and
finding them all in one place, plus the full auth matrix still passing.
Delivers one accountable owner for user invariants.

**Acceptance Scenarios**:

1. **Given** any auth flow that creates or mutates a user (register, password
   reset, Google link, phone verification flag), **When** it executes,
   **Then** the user-record write happens through the users boundary, never
   around it.
2. **Given** a code reviewer checking boundaries, **When** they list all
   user-record writes, **Then** they find zero outside the users boundary and
   the previously scattered writes are covered by tests proving identical
   outcomes.

---

### User Story 3 - Explicit transaction and failure boundaries (Priority: P2)

A maintainer reading a token flow (refresh rotation, reset, verification) can
point to exactly one all-or-nothing unit of work per flow. Partial results
never persist, and failures outside the unit (email send, event publish,
temporary-storage write) never undo an already-committed result.

**Why this priority**: Unclear ownership of all-or-nothing units is the plan's
central correctness finding. Auth must demonstrate the fixed rule because
order/expiration work copies this pattern.

**Independent Test**: Can be fully tested by fault-injection (event/temporary-
storage/mail failure still leaves committed token/user state intact; partial
token rotation never persists) plus review showing no data-access or partial-
unit logic in the request-handling layer. Delivers auditable, single-winner
concurrency.

**Acceptance Scenarios**:

1. **Given** a refresh rotation in progress, **When** the process crashes
   between invalidating the old credential and issuing the new one,
   **Then** no half-rotated state persists and retry
   semantics match the pre-refactor baseline.
2. **Given** two concurrent uses of the same single-use credential,
   **When** both race, **Then** exactly one succeeds and the other triggers
   theft protection, same as before.
3. **Given** a committed password reset or verification, **When** the follow-up
   notification publish fails, **Then** the committed state stands and the
   failure is logged/retried through the existing async path, never by rolling
   back the user-visible success.

---

### User Story 4 - Clean seams with no hidden behavior change (Priority: P3)

A maintainer extending tokens, rate limits, or notifications finds small,
named, intention-revealing units (token hashing, duration parsing, clock,
idempotency keys, event publishing) instead of copy-pasted inline logic, and
HTTP concerns (status codes, cookies, rate-limit responses) are handled in one
layer only.

**Why this priority**: The auth flow is large with triple-duplicated
hashing/expiry/cooldown logic and HTTP responses built inside business logic.
Extraction is justified only at proven shared responsibilities, never on size
alone.

**Independent Test**: Can be fully tested by unit matrices per shared unit
(identical outputs for identical inputs) plus unchanged request-handling
suites. Delivers extensibility without a framework.

**Acceptance Scenarios**:

1. **Given** any token hash or expiry computation, **When** computed before and
   after the refactor, **Then** outputs are byte-identical for the same inputs.
2. **Given** a rate-limited auth endpoint under load, **When** the limit is hit,
   **Then** the same throttled response and headers are returned as before, and
   throttling never corrupts data or leaves partial writes.
3. **Given** a reviewer checking for framework sprawl, **When** they inspect new
   shared units, **Then** each one is used in at least three places for the same
   reason and no one-size-fits-all base/framework unit exists.

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
  unreachable (allow + warn, never fail the request).
- Anti-enumeration: unknown emails on forgot-password/resend return the same
  neutral success as known emails; no timing or message oracle is introduced.
- Google sign-in with an unverified provider email is rejected; verified-email
  auto-link vs create behavior is unchanged.
- One-time-code endpoints remain explicitly unimplemented (501) and isolated;
  OTP behavior does not change.
- Registration response keeps its current shape and must not leak password
  material (pinned by test per clarified decision D3).
- Temporary-storage or message-broker outages preserve current fail-open
  semantics; the primary database remains the authority for tokens, users, and
  revocation.
- Misspelled directory and duplicated strategy files: file move only, proven by
  a passing build with zero behavior change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST preserve every observable auth/user contract
  (routes, status codes, response bodies, cookies, headers, event payloads,
  queue names, retry counts, lifetimes) byte-for-byte except where an approved
  behavior-changing decision explicitly documents the delta.
- **FR-002**: System MUST ensure user records are written in exactly one place
  (the users boundary); auth flows MUST NOT write user records themselves.
  Authentication reads use the same boundary or a documented read-only path.
  The users API itself is extended, not redesigned: existing operations keep
  their names and shapes; token flows get their own dedicated units rather
  than new user-surface operations.
- **FR-003**: System MUST make each multi-step token flow (refresh rotation +
  theft protection, password reset + token invalidation, verification + flag
  set, resend + prior invalidation) behave as one all-or-nothing unit:
  partial results MUST never persist, and units MUST never be nested inside
  each other.
- **FR-004**: System MUST keep request handling free of mixed
  responsibilities: the HTTP layer handles HTTP only and holds no data-access
  or partial-unit logic; all persistence lives behind the service boundary.
- **FR-005**: System MUST preserve single-use rotation with theft revoke-all,
  the per-user active-session cap with least-recent eviction, locked
  check-then-act decisions on token/refresh rows where the current code locks
  them, and the global token-version nuke. Concurrent uses of one single-use
  credential MUST yield exactly one winner.
- **FR-006**: System MUST store and log only token hashes (never raw tokens),
  keep hashed-prefix logging, and keep expiry/single-use checks enforced both
  by the database rules and the service checks.
- **FR-007**: System MUST NOT shape HTTP responses (rate-limit denials, auth
  challenges) inside business logic; the HTTP layer MUST own status/body/
  header/cookie shaping, and throttling MUST be decided before any data is
  locked or written.
- **FR-008**: System MUST perform side effects (event publish, mail trigger,
  temporary-storage write) only after the committed result is durable, and
  their failure MUST NOT undo committed state.
- **FR-009**: System MUST scope this refactor to auth + users files only; it MUST
  NOT modify order, reservation, inventory, cart, products, outbox, or
  notifications behavior or files (auth is a self-contained track). The shared
  rate-limit guard (used beyond auth) is explicitly frozen here: behavior-
  pinning tests only; its restructure belongs to a later phase. Likewise the
  duplicated email-provider setup is left untouched here; single-setup
  consolidation belongs to the notifications phase.
- **FR-010**: System MUST share helpers only for proven repeated
  responsibilities (used in at least three places for the same reason):
  token hash, secure-token generation, duration parsing, clock,
  quantity/cooldown guards, owner checks, pagination, correlation/refresh
  extraction, error mapping. It MUST NOT introduce one-size-fits-all
  base/generic/state-machine/repository framework units. Two-site similarities
  are merged only if touched.
- **FR-011**: System MUST NOT silently turn optional integrations into
  required ones, remove fail-open behavior, or hard-fail on missing config
  without an explicit, tested decision record per item. Token configuration is
  consolidated into one validated place with values identical to today's —
  no new hard-fail without separate approval.
- **FR-012**: System MUST land one full pre-split characterization baseline
  first (contract matrix + single-winner proofs for refresh reuse, reset
  reuse, verify reuse against a real database, all green) before any
  structural split; every later diff is measured against it. Performance
  observations are recorded as signals, never as targets.
- **FR-013**: System MUST document every touched unit per project doc rules
  and add short intent comments on non-obvious rules and calculations; it MUST
  NOT add new undocumented or untyped code without justification and MUST
  remove debug console output when touching those files.
- **FR-014**: System MUST resolve the two security-sensitive divergences and the
  registration-response question as decided in clarification (2026-10-02),
  each with regression tests:
  (a) S-1 dual sign-in verification paths → **unify to the request guard as
  the sole path, adding the missing token-version check there** (approved
  S-class change; revoked users are denied on every guarded route; both
  pre-paths pinned by tests first, then unified);
  (b) S-2 validate-vs-reset window → **validate stays an unlocked,
  non-authoritative pre-check, while the reset operation re-checks
  expiry/use/revocation at the moment it applies the change**,
  then consumes the token and changes the password as one unit (approved;
  concurrent validate+reset regression tests prove the window is closed at
  the authority point);
  (c) D3 registration response → **keep the current shape returning the
  created user object, with a pinned test proving no password material is
  ever present** (no shape change).

### Key Entities

- **User account**: identity record (email, name, role, verification flags,
  token version for global revocation); single writer is the users boundary.
- **Refresh session**: single-use credential record (stored as a hash, with
  expiry and revocation marker); rotation invalidates the old credential and
  issues the new one as one unit.
- **Password-reset token**: short-lived single-use record with expiry and use
  marker; prior active tokens are invalidated on each new request.
- **Email-verification token**: longer-lived single-use record with expiry,
  use marker, and resend cooldown.
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
  previously-passing test and no new undocumented or untyped code without
  justification.
- **SC-004**: A reviewer can verify: user records are written in exactly one
  place; request handling holds no data-access or partial-unit logic;
  side-effect failures never undo committed results; and HTTP shaping lives
  only in the HTTP layer.
- **SC-005**: Review of each new shared unit shows at least three proven uses
  with identical-output checks, and no one-size-fits-all framework unit
  is introduced.

## Clarifications

### Session 2026-10-02

- Q: Request-guard scope in this auth+users refactor → A: Freeze the shared guard — behavior-pinning tests only (including throttled-response headers), no structural change; its restructure belongs to a later phase.
- Q: User-record write API shape → A: Extend the existing users operations (keep names/shapes, add inputs only where needed); token flows get their own dedicated units.
- Q: Email-provider setup duplication → A: Leave for the notifications phase (no consolidation move now; single-setup consolidation belongs there).
- Q: Config scope → A: Consolidate token configuration into one validated place, read once at startup (with startup-wiring tests; no hard-fail on missing values without separate approval — values centralized, identical).
- Q: Characterization baseline strategy → A: Full pre-split baseline commit first (contract matrix + single-winner races green) before any structural split; every later diff measured against it.

## Assumptions

- Prerequisites are consumed, not rebuilt here: earlier baselines (correctness
  fix + security characterizations + hot-flow baselines) and shared helpers
  (time, hashing, duration handling) exist or are vendored minimally with
  identical behavior; this spec does not re-specify them.
- Public API, events, queues, and schema are frozen; no migration is emitted in
  this spec. Any behavior-changing delta requires a separate approved amendment.
- One-time-code sign-in stays explicitly unimplemented (501); behavior does
  not change.
- Misspelled directory and duplicated strategy files are addressed
  only as a file move with atomic import updates, proven by a passing build.
- Verification uses the project's standard gates on relevant suites plus
  concurrency suites against a real database where locked decisions are touched.
- Human approval is recorded (2026-10-02): S-1 unify sign-in verification with
  a revocation check; S-2 validate as pre-check + authoritative recheck in
  reset; D3 keep registration shape with no-password-leak pin. These three are
  approved behavior-changing deltas with regression tests; everything else
  stays behavior-preserving.
