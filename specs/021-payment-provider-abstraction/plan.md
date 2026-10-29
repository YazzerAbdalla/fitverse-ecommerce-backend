# Payment Provider Work --- Implementation Plan

## Working agreements

-   Implement one task at a time and review before starting dependent
    work.
-   Preserve and test current payment behavior before refactoring.
-   Any behavior change includes tests for its acceptance criteria.
-   Never perform a gateway HTTP request inside a database transaction.
-   Do not use `DataSource` in `PaymentService`; use injected
    `Repository<Payment>` for normal access and callback-provided
    `EntityManager` for transaction-scoped work.
-   Do not add a custom `PaymentRepository`.
-   Do not start Order checkout-facade integration until the
    provider/service and Stripe session/webhook phases have passed
    review.
-   If a required state-machine decision is unresolved, stop and update
    the spec rather than guessing.

## Phase A --- Contracts and baseline

### A-01 --- Confirm lifecycle decisions

-   Confirm bounded exponential retry parameters.
-   Confirm the outcome when payment succeeds after reservation expiry
    but stock is insufficient.
-   Confirm reservation terminal status and payment-attempt retry
    semantics.
-   Confirm API error status/envelope and cart restoration rules.
-   Document decisions in the feature spec.

**Done when:** implementation no longer has to guess these policies.

### A-02 --- Define acceptance criteria and characterize current behavior

-   Cover pending payment creation/idempotency, terminal-state
    conflicts, success, failure, cancellation, owner checks, list/get
    reads, and terminal re-confirmation.
-   Identify unit tests versus PostgreSQL integration tests.
-   Record the current state transitions before refactoring.

**Done when:** baseline behavior is covered by tests.

## Phase B --- Provider-neutral strategy and service refactor

### B-01 --- Define provider-neutral types

-   Define provider enum/type, checkout-session request/result,
    normalized webhook event, and payment outcome types.
-   Keep TypeORM entities, HTTP DTOs, and Stripe-specific types out of
    the common strategy contract.

### B-02 --- Define `PaymentStrategyInterface`

-   Add `createCheckoutSessionLink(request)`.
-   Add `verifyAndNormalizeWebhook(rawBody, headers)`.
-   Define required provider/session identifiers and normalized outcome
    shape.

### B-03 --- Extract transaction-scoped operations

-   Move transaction-dependent payment operations into functions that
    accept the callback-provided `EntityManager`.
-   Use `manager.getRepository(Payment)` for transactional locks/writes.
-   Preserve lock order: Payment → Order → Reservation → sorted
    Inventory rows.

### B-04 --- Remove `DataSource` from `PaymentService`

-   Use injected `Repository<Payment>` for ordinary reads/writes.
-   Keep transaction ownership in the appropriate facade.
-   Pass one manager through payment/order lifecycle operations in a
    transaction.

### B-05 --- Implement `LocalSimulationStrategy` if retained

-   Create a local checkout link without external network calls.
-   Normalize simulation outcomes to the same webhook/outcome contract.
-   Keep persistence and business transitions in services.

### B-06 --- Implement `PaymentProviderFactory`

-   Register strategies with NestJS dependency injection.
-   Read/validate `PAYMENT_PROVIDER` for new payment attempts.
-   Provide `getStrategy(provider)` with a clear unsupported-provider
    error.
-   Route callbacks using the provider persisted on the Payment, not
    just the current environment variable.

### B-07 --- Wire `PaymentService` to factory and strategy

-   Implement `createCheckoutSessionForOrder(...)` for an existing
    persisted pending Order.
-   Source the amount from the persisted Order total, not client input.
-   Create/persist the pending Payment before calling the gateway.
-   Call the selected strategy outside any database transaction.
-   Persist provider and provider session reference.
-   Return a typed result containing session ID and URL.

### B-08 --- Verify provider/service refactor

-   Add unit tests for strategy, factory, and service.
-   Add PostgreSQL tests for rollback and concurrent payment outcomes.
-   Compare results with Phase A baseline.

**Checkpoint:** accept and verify Phase B before implementing
Stripe-specific behavior.

## Phase C --- Stripe Checkout Session and webhook

### C-01 --- Add validated Stripe configuration

-   Configure Stripe secret, webhook secret, success URL, and cancel URL
    through the project config pattern.
-   Require Stripe-specific settings only when Stripe is selected.
-   Never log secrets.

### C-02 --- Add provider session persistence

-   Add provider session reference to Payment.
-   Add an additive migration and justified provider-scoped
    uniqueness/index.
-   Test migration up/down and session recreation behavior.

### C-03 --- Implement Stripe Checkout Session creation

-   Create a one-time hosted Checkout Session for an existing pending
    Order.
-   Use persisted Order total and currency-aware minor-unit conversion.
-   Use a stable idempotency key for retries of the same logical
    attempt.
-   Return session ID and URL; persist the session reference through
    `PaymentService`.

### C-04 --- Preserve raw webhook body

-   Configure NestJS so Stripe receives the exact raw bytes for
    signature verification.
-   Keep normal JSON parsing intact for other routes.
-   Test valid and modified-body signatures.

### C-05 --- Persist webhook events and deduplicate

-   Add webhook event persistence.
-   Add unique constraint on provider + event ID.
-   Define claim/processed behavior that permits safe retry after
    transaction rollback.
-   Test concurrent duplicate delivery.

### C-06 --- Verify and normalize Stripe webhooks

-   Verify signature using the configured webhook secret.
-   Normalize supported success, asynchronous failure/success, and
    expiry events.
-   Reject invalid signatures and malformed payloads safely.
-   Keep provider-specific event handling inside the strategy/adapter
    layer.

### C-07 --- Add webhook controller

-   Expose provider callback route without customer JWT authentication.
-   Pass raw body and signature headers to the application service.
-   Keep controller free of payment business logic and direct database
    writes.

### C-08 --- Apply outcomes atomically

-   Claim/deduplicate the event and lock the Payment in the transaction
    facade.
-   Validate provider/session/payment/order association, amount, and
    currency.
-   On success, invoke existing order completion/reservation/inventory
    operations with the same `EntityManager`.
-   On failure/expiry, invoke the established
    failure/cancellation/release operations.
-   Persist payment and webhook processing state atomically.
-   Ensure duplicate events cannot repeat inventory or cart effects.

### C-09 --- Verify Stripe end to end against an existing pending Order

-   Use Stripe test mode/CLI.
-   Verify success, failure, asynchronous outcomes where applicable,
    expiry, invalid signature, and duplicate event delivery.
-   Verify Order, Payment, Reservation, Inventory, and cart state.
-   Demonstrate this independently of the new checkout facade.

**Checkpoint:** accept Phase C before checkout-facade integration.

## Phase D --- Gateway failure recovery

### D-01 --- Implement bounded exponential retries

-   Retry only appropriate transient session-creation failures.
-   Define maximum attempts, delay schedule, total retry window, and
    jitter.
-   Reuse the stable idempotency key for the same logical attempt.
-   Do not retry permanent configuration/validation errors indefinitely.

### D-02 --- Implement compensation after retries are exhausted

-   In a database transaction, mark Order failed, Payment failed, and
    Reservation failed/cancelled using valid state transitions.
-   Release reserved inventory once.
-   Restore products and quantities to the customer's cart without
    duplicating existing cart quantities.
-   Make compensation idempotent and safe to retry.
-   If compensation fails, record a recoverable state and reconcile
    later.

### D-03 --- Verify recovery

-   Test transient failure followed by success.
-   Test exhausted retries and compensation.
-   Test Stripe created a session but the application timed out before
    receiving/persisting the result.
-   Test compensation retry and concurrent webhook/compensation races.

## Phase E --- Order checkout-facade integration

Start only after Phases B and C pass review; gateway recovery policy
from Phase D must also be implemented before relying on it in checkout.

### E-01 --- Finalize checkout response contract

-   Match existing API response conventions.
-   Success includes persisted Order data and `payment_session_link`.
-   Failure returns the agreed non-success status and safe message.
-   Never accept the amount from the client.

### E-02 --- Connect Order checkout facade to PaymentService

-   Order facade owns cart validation, authoritative total, pending
    Order, reservation, inventory reservation, and first database
    transaction.
-   Commit the first transaction.
-   Create the pending Payment after commit.
-   Call the exported PaymentService operation to create the provider
    session.
-   Return the checkout URL with the Order response.
-   Do not inject payment repositories or Stripe clients into Order
    code.

### E-03 --- Handle reservation expiry/webhook race

-   Enforce the 15-minute reservation TTL from the agreed start point.
-   Ensure expiry and webhook outcome use compatible locks and
    deterministic transitions.
-   On a successful payment webhook after expiry, recheck stock under
    lock; proceed only if the defined policy allows it.

### E-04 --- Full checkout-to-webhook E2E verification

-   Verify success response contains the provider URL.
-   Verify success webhook completes the Order and inventory effects
    once.
-   Verify failure/expiry releases reservation without selling
    inventory.
-   Verify duplicate events, gateway failure/compensation, ownership,
    and 15-minute expiry behavior.
-   Run PostgreSQL integration tests plus Stripe test mode/local
    simulation.

**Done when:** checkout, payment, reservation, inventory, and webhook
behavior pass end-to-end acceptance tests.

## Review checkpoints

1.  Phase A: decisions and baseline accepted.
2.  Phase B: provider-neutral refactor and factory/service tests
    accepted.
3.  Phase C: Stripe session/webhook verified independently against an
    existing pending Order.
4.  Phase D: gateway retry/compensation behavior verified.
5.  Phase E: checkout facade integrated and full end-to-end tests
    accepted.
