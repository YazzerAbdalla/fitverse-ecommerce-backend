# Feature Specification: Reconcile + Baseline (S1)

**Feature Branch**: `016-baseline`
**Created**: 2026-10-06
**Status**: Draft
**Input**: User description: "start the first session in the refactor plan"
**Plan ref**: `docs/REFACTOR_PLAN.md` §14 S1 (covers Phase 0 + §13 P0-6/P0-7)

## Background

S1 is the first of seven implementation sessions packaging the Rev. 3 refactor plan. Its job is to stabilize the foundation before any abstraction is built: reconcile what `git log` already merged (RP-AUTH + verification-token fold, commit `030dcd8` and below) against what the plan still lists as open, fix the one known data-growth bug in outbox retention cleanup, close two security-relevant inconsistencies at the narrowest possible scope, rotate leaked secrets, and pin the current behavior of every hot flow with characterization tests so later sessions can prove equivalence.

## Clarifications

### Session 2026-10-06

- Q: Which outbox statuses count as "terminal" for retention deletion? → A: All end-states — `SENT`/`SENT_TO_MQ`/`CONSUMED`/`DELIVERED` + `FAILED`.
- Q: Where does the CORS allow-list come from? → A: The existing frontend-URL value serves as the default entry, extended by an optional comma-separated list variable.
- Q: Where does the secret gate run? → A: Both — a local pre-commit hook for instant feedback plus a CI pipeline step for enforcement.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Expired outbox records are actually removed (Priority: P1)

The platform retains completed outbox records for a bounded period (default 30 days) so operators can audit delivery and retry failures. Today the retention cleanup runs but deletes nothing: the delete statement compares a status column against a day-count value, so no row ever matches and the table grows without bound. As an operator, I run cleanup and expired terminal records disappear while fresh and non-terminal records stay.

**Why this priority**: Unbounded table growth is the only confirmed correctness bug in the baseline; every later session inherits this table. It ships as an isolated change before anything else.

**Independent Test**: Seed old terminal records, fresh terminal records, and non-terminal records, run cleanup once, and confirm only the expired terminal records are gone.

**Acceptance Scenarios**:

1. **Given** terminal records older than the retention period, **When** cleanup runs, **Then** those records are deleted and the deleted count is reported.
2. **Given** fresh terminal records inside the retention period, **When** cleanup runs, **Then** they are preserved.
3. **Given** non-terminal (pending/retryable) records even if old, **When** cleanup runs, **Then** they are preserved.

---

### User Story 2 - Leaked secrets are rotated and the repo stops accepting real credentials (Priority: P1)

Real third-party credentials were found as live values in the on-disk environment file. As a maintainer, I want both keys rotated at their providers, the on-disk file stripped back to placeholders matching the committed example file, confirmation the environment file is git-ignored, and an automated gate that rejects real-looking secrets in future commits.

**Why this priority**: Active credential exposure; blocks nothing technically but outranks all other S1 work in urgency. Requires human approval and human action at the providers (code cannot rotate third-party keys).

**Independent Test**: Diff the on-disk environment file against the example file's placeholder pattern, confirm git-ignore status, and confirm the secret gate triggers on a planted fake key and passes on placeholders.

**Acceptance Scenarios**:

1. **Given** a rotated key at the provider, **When** the on-disk file is inspected, **Then** it contains only a placeholder, never the live value.
2. **Given** a commit containing a real-looking provider key pattern, **When** the gate runs, **Then** the commit is rejected with a message naming the offending pattern.
3. **Given** the standard environment file, **When** git status is checked, **Then** the file is untracked/ignored.

---

### User Story 3 - Browsers only send credentials to listed origins (Priority: P2)

The API currently reflects any origin while allowing credentials, so any site can make authenticated cross-origin requests in a logged-in browser. As a security reviewer, I want credentialed access limited to an explicit allow-list loaded from configuration, with all other origins rejected, while non-browser clients (tools without an origin) keep working.

**Why this priority**: Credentialed cross-site request forgery. The fix is a one-line-class change plus a test, but it is approval-gated as a security behavior change.

**Independent Test**: Send requests with a listed origin, an unlisted origin, and no origin; confirm allow / reject / allow respectively, with credentials honored only for the listed origin.

**Acceptance Scenarios**:

1. **Given** a request from a listed origin with credentials, **When** it arrives, **Then** it is accepted with credential support.
2. **Given** a request from an unlisted origin with credentials, **When** it arrives, **Then** it is rejected (no credentialed access).
3. **Given** a non-browser client with no origin, **When** it calls the API, **Then** it works as before.

---

### User Story 4 - Current auth edge behavior is pinned before later sessions touch it (Priority: P2)

Two request-authentication paths currently coexist and diverge (one checks session revocation, the other does not), and the password-reset validation endpoint reads without the lock its sibling write endpoint uses. Later sessions will unify these paths, which requires deciding which behavior survives. As a maintainer, I want the *current* behavior of both paths locked by tests now — including the revoked-session matrix and the concurrent validate-plus-reset window — so the unification decision is made against evidence, with no behavior changed in this session.

**Why this priority**: Every later auth/outbox abstraction inherits these semantics. Characterizing first prevents building on undefined behavior. Strictly no behavior change here.

**Independent Test**: Run the pinned test matrix on unmodified behavior; all pins pass and any future behavior change fails them loudly.

**Acceptance Scenarios**:

1. **Given** a revoked session presented on each authentication path, **When** the request is made, **Then** each path's current allow/deny outcome is asserted by a named test.
2. **Given** concurrent reset-validation and password-reset for the same token, **When** both execute, **Then** the observed outcome window is documented by a test.
3. **Given** a revoked user opening a realtime connection, **When** the connection is attempted, **Then** the current outcome is asserted by a test.

---

### User Story 5 - Hot flows have green baselines proving today's behavior (Priority: P3)

Session-token rotation and theft handling, checkout totals and snapshots, reservation completion idempotency, email verification and resend, outbox claim/publish/retry, and concurrent last-unit races all need "before" snapshots. As a maintainer starting S2, I want one green suite per flow on unmodified code so any later regression is caught mechanically.

**Why this priority**: Enables every later session's behavioral gate. Lowest priority only because it records rather than changes anything.

**Independent Test**: Run the full baseline suite; every suite is green on unmodified code and each suite fails if the corresponding behavior changes.

**Acceptance Scenarios**:

1. **Given** unmodified code, **When** the baseline suite runs, **Then** all suites pass, including concurrent single-winner races.
2. **Given** the merged RP-AUTH/token-fold commits, **When** the reconcile checklist runs, **Then** each plan item is marked done-with-evidence or open, with no item left ambiguous.

---

### Edge Cases

- Cleanup runs when the outbox table is empty → reports zero, no error.
- Cleanup runs with a missing or absurd retention setting → falls back to the documented default and warns once.
- CORS allow-list is empty or unset at boot → fail closed in production (reject credentialed origins), warn in development.
- Secrets gate encounters placeholder values from the example file → passes, never flags placeholders.
- Characterization tests run without live infrastructure (no database) → skip cleanly with a visible skip reason, never false-pass.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Retention cleanup MUST delete only expired terminal outbox records — terminal means every end-state (`SENT`, `SENT_TO_MQ`, `CONSUMED`, `DELIVERED`, `FAILED`) — and MUST preserve fresh terminal records and all non-terminal records.
- **FR-002**: Retention cleanup MUST run isolated from any other change (single-purpose commit) and MUST report the deleted count.
- **FR-003**: Live third-party credentials MUST NOT exist in the on-disk environment file; placeholders matching the committed example file MUST be used instead.
- **FR-004**: The environment file MUST be git-ignored, and a secret gate MUST reject real-looking provider key patterns both locally (pre-commit hook) and in CI (pipeline step).
- **FR-005**: Credentialed browser access MUST be limited to an explicit configuration-driven origin allow-list — the existing frontend-URL value plus an optional comma-separated extension list; unlisted origins MUST NOT receive credential support.
- **FR-006**: Non-browser clients without an origin MUST continue to work after the CORS change.
- **FR-007**: The current allow/deny outcomes of both authentication paths for revoked sessions MUST be asserted by named tests, with zero behavior change.
- **FR-008**: The concurrent validate-plus-reset outcome window MUST be documented by a test, with zero behavior change.
- **FR-009**: The current realtime-connection outcome for revoked users MUST be asserted by a test, with zero behavior change.
- **FR-010**: Each hot flow (session rotation/theft, checkout totals/snapshots, completion idempotency, verification/resend, outbox claim/publish/retry, last-unit races) MUST have a green baseline suite on unmodified code.
- **FR-011**: A reconcile checklist MUST map every Phase 0 and S1 plan item to done-with-evidence or open, cross-checked against merged commits.

### Key Entities

- **Outbox record**: a durable domain-event row with a lifecycle (pending → in-flight → terminal) and timestamps; retention applies to terminal rows past the retention period.
- **Origin allow-list**: the configured set of trusted web origins permitted credentialed browser access.
- **Characterization pin**: a test that asserts current behavior without endorsing it, failing loudly on any change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Seeded expired terminal records are removed by cleanup while fresh and non-terminal records survive (100% of seeded cases).
- **SC-002**: No live third-party credential remains on disk, the environment file is git-ignored, and the gate rejects 100% of planted real-looking keys while passing placeholders.
- **SC-003**: Requests from unlisted origins are denied credentialed access in 100% of trials while listed origins and origin-less clients succeed.
- **SC-004**: All authentication-behavior pins pass on unmodified code, and any intentional behavior change later fails the corresponding pin.
- **SC-005**: Every hot-flow baseline suite is green before S1 closes, and the reconcile checklist leaves zero plan items ambiguous.

## Assumptions

- The outbox retention default (30 days) stays as documented; the terminal set is the clarified all-end-states definition above (this corrects matching, not policy — previously non-matching rows could never be deleted by design).
- The CORS allow-list reuses the existing frontend-URL configuration value as its initial entry; additional origins are a later concern.
- Secret rotation at third-party providers is performed by the human operator; this session covers stripping, verification, and gating.
- RP-AUTH and the verification-token fold are treated as merged (per `git log`); S1 verifies rather than re-implements them.
- Live infrastructure (database, cache, broker) is available for baseline runs; otherwise suites skip cleanly and S1 does not close until they run green.
