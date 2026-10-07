# Feature Specification: Payment Simulation (Demo)

**Feature Branch**: `018-payment-simulation`
**Created**: 2026-10-07
**Status**: Draft
**Input**: User description: "Phase 19 payment simulation demo — checkout to payment to order completion end-to-end without real Stripe"

## Clarifications

### Session 2026-10-07

- Q: Who may intent/confirm/cancel payments — owner-only or also Admin? → A: Owner-only writes
- Q: Reservation expires while payment PENDING — what wins? → A: Payment blocks expiry
- Q: Should payment intent/confirm be rate-limited? → A: Reuse checkout 10/h
- Q: How strict should failureReason be on declined confirms? → A: Fixed enum
- Q: What pagination/filters should payment listing support? → A: Status only

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pay for my order successfully (Priority: P1)

A shopper who just checked out has a pending order with reserved inventory. They start a payment for that order and confirm it as successful. The order becomes completed, the reservation is completed, and the held inventory becomes sold.

**Why this priority**: This is the core demo flow. Without it there is no clickable checkout-to-completion path.

**Independent Test**: Can be fully tested by registering a user, adding products to cart, checking out, starting a payment, confirming success, then verifying the order shows completed and inventory decreased once.

**Acceptance Scenarios**:

1. **Given** a shopper has a pending order with total 250, **When** they start a payment for that order, **Then** a pending payment is created with the same amount and currency `usd` and no external provider is contacted.
2. **Given** a pending payment exists for a pending order, **When** the shopper confirms with result `success`, **Then** the payment shows succeeded, the order shows completed, the reservation shows completed, and stock is decreased exactly once while the hold is released.
3. **Given** a succeeded payment, **When** the shopper confirms it again with any result, **Then** they get the same already-processed result with zero change to order, reservation, or inventory.

---

### User Story 2 - Handle declined card (Priority: P1)

A shopper starts a payment but their card is declined. The order must fail cleanly and the held inventory must be released so they can retry with a new checkout.

**Why this priority**: Failure path is equally load-bearing for the demo; without it a decline looks like a stuck order.

**Independent Test**: Can be fully tested by checking out, starting a payment, confirming with `declined`, then verifying the order shows failed, the reservation is cancelled, and available inventory is restored.

**Acceptance Scenarios**:

1. **Given** a pending payment exists, **When** the shopper confirms with result `declined` and reason `card_declined`, **Then** the payment shows failed, the order shows failed, the reservation shows cancelled, stock is unchanged, and the hold is released.
2. **Given** a failed payment, **When** the shopper confirms it again, **Then** they get the already-processed result with zero further inventory change.

---

### User Story 3 - Cancel before paying (Priority: P2)

A shopper changes their mind after starting a payment but before confirming. They cancel the payment and the order is cancelled with the hold released.

**Why this priority**: Covers the pre-confirm abandon path with minimal extra scope.

**Independent Test**: Can be fully tested by checking out, starting a payment, cancelling it, then verifying payment and order show cancelled and the hold is released.

**Acceptance Scenarios**:

1. **Given** a pending payment exists, **When** the shopper cancels it, **Then** the payment and order show cancelled, the reservation is cancelled, and the hold is released with stock unchanged.
2. **Given** a succeeded, failed, or already-cancelled payment, **When** the shopper tries to cancel it, **Then** the request is rejected as a conflict for terminal states (re-confirm stays idempotent success instead).

---

### User Story 4 - View my payments (Priority: P3)

A shopper or support admin needs to look up a payment or list payments to answer "what happened to my order?".

**Why this priority**: Read-only support for the demo; no business state changes.

**Independent Test**: Can be fully tested by creating two payments, then fetching one by id and listing with pagination as owner and as admin.

**Acceptance Scenarios**:

1. **Given** a shopper owns a payment, **When** they fetch it by id, **Then** they see its amount, currency, status, and linked order.
2. **Given** several payments exist, **When** the shopper lists payments, **Then** they see only their own payments in newest-first paginated order with optional status filter; an admin can optionally filter by user.
3. **Given** a shopper requests another shopper's payment, **When** the system checks ownership, **Then** access is denied.

---

### Edge Cases

- What happens when two confirm requests for the same payment arrive at the same time? Only one state change wins; the other returns the already-processed result with no double stock movement.
- How does the system handle starting a second payment for the same order? If a pending payment already exists it returns the same payment; if a terminal payment exists it rejects with a conflict.
- What happens when the payment references a missing order, a non-pending order, or another user's order? Missing maps to not-found, wrong status maps to conflict, wrong owner maps to forbidden.
- What happens when confirm or cancel payloads carry invalid result values or extra fields? The request is rejected as bad input with no state change.
- What happens when checkout succeeds but payment creation never happens? The order stays pending with its reservation intact until expiry or manual cancel (unchanged existing behavior).
- What happens when the reservation expiry timer elapses while a payment is still pending? Expiry is deferred: an active pending payment blocks automatic expiry until the payment is confirmed, declined, or cancelled, so a shopper mid-pay is never expired out from under them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Shoppers MUST be able to start a payment for their own pending order, providing only the order reference; the system MUST copy the amount from the order and default currency to `usd`.
- **FR-002**: System MUST enforce one payment per order: a second start for the same order with a pending payment MUST return the existing payment; with a terminal payment MUST reject as a conflict.
- **FR-003**: Shoppers MUST be able to confirm their own pending payment with either `success` or `declined` plus a failure reason drawn from a fixed set (`card_declined`, `insufficient_funds`, `expired_card`) when declined.
- **FR-004**: On `success` confirm, system MUST atomically mark payment succeeded, order completed, and reservation completed, converting the held quantity into sold quantity (all-or-nothing; any failure rolls back everything).
- **FR-005**: On `declined` confirm, system MUST atomically mark payment failed, order failed, and reservation cancelled, releasing the hold without changing stock (cart stays cleared so the shopper re-adds items for retry).
- **FR-006**: Shoppers MUST be able to cancel their own pending payment; the system MUST atomically mark payment cancelled, order cancelled, and reservation cancelled with hold released.
- **FR-007**: Re-confirming or re-reading a terminal payment (succeeded, failed, cancelled) MUST return the already-processed result with zero inventory change; cancelling a terminal payment MUST be rejected.
- **FR-008**: System MUST enforce owner-only writes on every payment mutation (start, confirm, cancel): only the owning shopper acts; non-owners including admins MUST be denied (403). Admins may additionally read any payment (single fetch and list with user filter); shoppers see only their own.
- **FR-009**: System MUST validate all payment inputs (order reference is a valid identifier, result is `success` or `declined`, failure reason when declined is one of `card_declined | insufficient_funds | expired_card`) and reject unknown fields and bad values without state change.
- **FR-010**: Only pending orders MAY start a payment; completed, failed, or cancelled orders MUST be rejected as conflicts.
- **FR-011**: Shoppers MUST be able to fetch a single payment and list their payments newest-first with pagination and optional status filter (no order filter in demo).
- **FR-012**: Payment responses MUST expose id, linked order, amount, currency, status, provider label `simulation`, and failure reason when present; existing order fields MUST remain unchanged.

### Key Entities *(include if feature involves data)*

- **Payment**: Represents a shopper's attempt to pay for one order. Key attributes: linked order (exactly one payment per order), owning user, amount copied from the order at creation, currency (`usd`), status (`pending`, `succeeded`, `failed`, `cancelled`), provider label (`simulation`), optional failure reason.
- **Order (existing, linked)**: Payment success moves a pending order to completed; decline moves it to failed; pre-confirm cancel moves it to cancelled. Terminal orders never accept new payments.
- **Reservation (existing, linked)**: Success completes the reservation (hold converts to sale); decline or cancel cancels the reservation (hold released, stock unchanged).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A shopper can go from checkout to completed order via payment confirm in under 2 minutes of active interaction in the demo script.
- **SC-002**: 100% of successful confirms result in exactly one inventory decrement even under duplicate or concurrent confirm attempts (zero double-sells observed in tests).
- **SC-003**: 100% of declined or cancelled payments release the held inventory with stock unchanged, leaving the shopper able to check out again.
- **SC-004**: 95% of first-attempt demo runs (success path and decline path) complete without operator intervention or data reset.

## Assumptions

- Demo scope only: simulated provider (`simulation`), no real card network, no secrets, no webhooks, no cents conversion (amount uses the same unit as order total).
- One payment per order for the demo; partial captures, multiple intents, and refunds for completed orders are out of scope.
- Currency is fixed to `usd`; any configurability is a display default, not per-request input.
- Shoppers never supply the amount; the system always copies it from the order to prevent tampering.
- Existing checkout, order completion, reservation lifecycle, ownership checks, and rate-limiting behavior are reused unchanged.
- Payment intent and confirm reuse the existing checkout 10/hour per-user throttling buckets; exceeding the limit is rejected without state change and reads stay unthrottled.
- Full card-brand testing, 3D Secure redirects, and live-mode operation are explicitly deferred to post-demo Stripe work.
