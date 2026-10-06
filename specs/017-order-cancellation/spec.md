# Feature Specification: Order Cancellation

**Feature Branch**: `017-order-cancellation`
**Created**: 2026-10-06
**Status**: Draft
**Input**: User description: "ok let's start with phase 8"
**Plan reference**: `docs/plan.md` Phase 8 — Order Cancellation (exit bar: no double-release / double-return)

## Clarifications

### Session 2026-10-06

- Q: On the payment-failure path (order → FAILED), what happens to the linked RESERVED reservation? → A: Release the hold, reservation → CANCELLED, order → FAILED (same inventory release as a shopper cancel; only the order status differs).
- Q: What does the cancel response carry? → A: Enriched — order id, status, reason, reservation link.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cancel a pending order before sale (Priority: P1)

A shopper who checked out but changed their mind cancels their still-pending
order. The order becomes cancelled, the linked reservation is released, and the
reserved units become available for other shoppers. Shelf stock does not change
because nothing was sold.

**Why this priority**: This is the core of Phase 8 and the demo exit bar. Every
other cancellation path builds on this state machine and inventory rule.

**Independent Test**: Can be fully tested by checking out (order PENDING +
reservation RESERVED), cancelling, then verifying the order reads CANCELLED,
the reservation reads CANCELLED, and available inventory is restored while
shelf stock is unchanged.

**Acceptance Scenarios**:

1. **Given** a PENDING order with a RESERVED reservation (2 units held),
   **When** the owning shopper cancels, **Then** the order reads CANCELLED, the
   reservation reads CANCELLED, reserved units drop by 2, and shelf stock is
   unchanged.
2. **Given** a PENDING order, **When** the shopper cancels twice in a row,
   **Then** both attempts succeed with the same result and inventory moves only
   once (zero delta on the second attempt).
3. **Given** a PENDING order, **When** a different shopper tries to cancel it,
   **Then** the attempt is rejected as forbidden.
4. **Given** a COMPLETED order (sale already converted), **When** anyone tries
   to cancel it, **Then** the attempt is rejected as a conflicting transition
   and stock is untouched.

---

### User Story 2 - Admin and system-driven cancellation (Priority: P2)

Support staff (admin) can cancel a shopper's pending order on their behalf, and
the system itself cancels orders when their reservation expires or the related
payment fails. All three paths end in the same consistent state: order closed,
reservation released, one inventory movement.

**Why this priority**: Expiration auto-cancel already happens inside the
expiration worker and the failure path is needed by the payment flow; unifying
them on one cancellation rule removes a whole class of double-release bugs.

**Independent Test**: Can be fully tested by (a) cancelling another user's
pending order as admin, and (b) letting a pending order's reservation expire
and verifying the order ends cancelled with inventory released exactly once.

**Acceptance Scenarios**:

1. **Given** a PENDING order owned by shopper A, **When** an admin cancels it,
   **Then** the order reads CANCELLED and inventory is released exactly as if
   the shopper had cancelled.
2. **Given** a PENDING order whose reservation reaches expiry, **When** the
   expiration cleanup runs, **Then** the order ends CANCELLED and the
   reservation ends EXPIRED with a single inventory release (no double-release
   between the user-cancel and expiry paths racing each other).

---

### User Story 3 - Cancellation is observable (Priority: P3)

After cancelling, the shopper (and support) can see what happened: the order's
cancelled state, the reason (shopper choice, expiry, or failure), and a
notification record of the cancellation for downstream consumers.

**Why this priority**: Observability, not correctness — it makes cancellations
auditable and lets notifications/analytics react without polling order state.

**Independent Test**: Can be fully tested by cancelling an order and verifying
a cancellation record exists carrying the order id, previous and new status,
and the reason.

**Acceptance Scenarios**:

1. **Given** a PENDING order, **When** it is cancelled for any reason,
   **Then** a cancellation record exists with the order id, previous status
   PENDING, the new status, and the reason (shopper / expired / failed).
2. **Given** a cancelled order, **When** it is listed or fetched,
   **Then** its CANCELLED status and reason are visible to the owner and to
   admins.

---

### Edge Cases

- What happens when cancel is requested but the linked reservation is already
  in a terminal state (COMPLETED / CANCELLED / EXPIRED)? Order still closes;
  inventory must not move a second time.
- What happens when cancel races completion or expiry on the same order at the
  same instant? Exactly one transition wins; the loser sees the settled state
  and inventory moves exactly once.
- What happens when the order's inventory record is missing? The cancel fails
  cleanly, the order stays PENDING, and nothing is half-released.
- What happens when the same cancel is submitted twice (double-click / retry
  after timeout)? The second attempt returns the already-cancelled order with
  zero additional inventory movement.
- What happens when the cancellation notification record cannot be written?
  The whole cancel rolls back (locked Q2/A): a committed cancel is never
  silent; the failure surfaces as a retryable error and the shopper retries
  the cancel.
- Does cancelling restore the shopper's cart? No — the cart stays cleared
  (locked Q3/A); the shopper re-adds items for a new order.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Shoppers MUST be able to cancel their own PENDING orders; admins
  MUST be able to cancel any PENDING order.
- **FR-002**: System MUST define and enforce the order cancellation state
  machine: PENDING can move to CANCELLED (shopper/admin/expiry) or FAILED
  (payment failure); CANCELLED, FAILED, and COMPLETED are terminal and accept
  no outgoing cancellation transition except idempotent re-cancel of an
  already-cancelled order.
- **FR-003**: Cancelling a pending (pre-sale) order MUST release the held
  units (reserved quantity decreases) and MUST leave shelf stock unchanged.
  The payment-failure path (order → FAILED) releases the hold identically —
  the linked reservation moves RESERVED → CANCELLED; only the order status
  differs (FAILED instead of CANCELLED).
- **FR-004**: Cancellation MUST be atomic: the order status change, the
  reservation status change, and the inventory release MUST all succeed or all
  roll back together — never a half-cancelled state.
- **FR-005**: Re-cancelling an already-CANCELLED (or already-FAILED) order MUST
  succeed idempotently with zero additional inventory movement.
- **FR-006**: Cancelling a COMPLETED order MUST be rejected as a conflict;
  post-sale refund behaviour (returning sold units to stock) is explicitly out
  of scope for this feature (locked Q1/A: cancel-before-sale only).
- **FR-007**: Cancelling a FAILED order MUST be rejected as a conflict (same
  terminal-state rule as COMPLETED).
- **FR-008**: Concurrent cancel vs complete vs expire on the same order MUST
  resolve to exactly one winner with exactly one inventory movement; losers
  MUST observe the settled state without corrupting inventory.
- **FR-009**: Every cancellation MUST produce a durable cancellation record
  (order id, previous status, new status, reason, reservation link) in the same
  atomic unit as the state change, so a committed cancel is never silent to
  downstream consumers.
- **FR-010**: Cancellation attempts by non-owners who are not admins MUST be
  rejected as forbidden; unauthenticated attempts MUST be rejected as
  unauthenticated.
- **FR-011**: Cancellation MUST never double-release (reserved units
  decremented twice for one hold) or double-return (sold units added back
  twice) inventory under any retry, replay, or race.
- **FR-012**: The cancel response MUST carry the order id, the new status, the
  reason (shopper / expired / failed), and the linked reservation id, so the
  released hold is traceable without a second lookup.

### Key Entities

- **Order**: What the shopper bought; key attributes are owner, status
  (PENDING / COMPLETED / CANCELLED / FAILED), total, and link to its
  reservation.
- **Reservation**: The temporary hold on inventory for the order; key
  attributes are status (RESERVED / COMPLETED / CANCELLED / EXPIRED) and its
  line items (inventory reference + quantity each).
- **Inventory**: Shelf stock per product; key attributes are stock on hand,
  reserved quantity, and derived availability (stock minus reserved).
- **Cancellation record**: The durable trace of a cancel; key attributes are
  order id, previous status, new status, reason (shopper / expired / failed),
  and reservation link.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A shopper can cancel a pending order and see it read CANCELLED
  with held units returned to availability within one request round-trip.
- **SC-002**: Cancelling the same order twice moves inventory exactly once —
  the second cancel changes nothing (100% of replayed cancels are zero-delta).
- **SC-003**: 100% of attempts to cancel a COMPLETED or FAILED order are
  rejected with no change to stock or reserved quantities.
- **SC-004**: When cancel and complete are fired simultaneously against the
  same pending order, exactly one succeeds in changing inventory and the final
  state (CANCELLED with released hold, or COMPLETED with sold stock) is
  internally consistent — never both, never half-applied.
- **SC-005**: Every committed cancellation has a matching cancellation record
  (zero silent cancels observed over the verification run).

## Assumptions

- Post-sale refund (COMPLETED → CANCELLED with units returned to stock, refund
  behaviour) is deferred to a later phase; this feature covers
  cancel-before-sale only, per `docs/plan.md` Phase 8 demo scope (locked Q1/A).
- The existing expiration worker's auto-cancel of expired reservations and the
  payment failure path reuse this feature's cancellation rule rather than each
  implementing their own.
- A cancelled order's cart stays cleared (shopper re-adds items for a new
  order) — locked Q3/A.
- Cancelling never restores or modifies product prices or order totals; the
  cancelled order keeps its snapshot for audit.
- Rate limiting and authentication plumbing are reused as-is; no new auth
  model is introduced here.
