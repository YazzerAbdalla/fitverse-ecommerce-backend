# Payment Provider and Checkout Integration --- Feature Specification

## 1. Purpose

Separate payment-gateway integration from payment business/data logic,
support provider selection through `PAYMENT_PROVIDER`, and connect
checkout-session creation to verified webhook outcomes.

## 2. Scope

### In scope

-   Provider-neutral payment strategy contract.
-   Provider selection through `PAYMENT_PROVIDER`.
-   `PaymentProviderFactory` returning the selected strategy.
-   `PaymentService` orchestration and payment persistence.
-   Stripe Checkout Session creation and webhook
    verification/normalization.
-   Session-link response from checkout.
-   Payment success, failure, cancellation, duplicate webhook, and
    ownership behavior.
-   Gateway-session creation retries and compensation after retries are
    exhausted.
-   Reservation expiry/webhook race handling.

### Deferred

-   Order checkout-facade integration is implemented only after the
    provider/factory/payment service and Stripe webhook flow have been
    verified against an existing pending order.
-   Do not add payment repositories or Stripe SDK dependencies to the
    Order module.

## 3. Architecture and responsibilities

### `PaymentStrategyInterface`

Provider-neutral contract for creating a checkout-session link and
verifying/normalizing provider webhook events. Strategy contracts must
not depend on TypeORM entities, HTTP DTOs, or provider-specific types in
their common result.

### `StripeStrategy`

Calls Stripe APIs to create Checkout Sessions and verifies Stripe
webhook signatures using the untouched raw request body. Returns
provider identifiers and a hosted checkout URL. It does not persist
payments or mutate orders/reservations/inventory.

### `PaymentProviderFactory`

Reads/uses the configured `PAYMENT_PROVIDER` and returns the matching
registered strategy. It fails clearly for an unsupported provider. For
webhook handling, provider selection must use the provider saved on the
existing Payment record rather than blindly using the current
environment setting.

### `PaymentService`

Owns payment application/data logic: creates or updates Payment records,
calls the factory-selected strategy, persists provider/session
correlation, validates payment/order association, and orchestrates
normalized payment outcomes. It uses an injected `Repository<Payment>`
for ordinary access and the callback-provided `EntityManager` for
transaction-scoped work. Do not inject `DataSource` into
`PaymentService`; do not add a custom `PaymentRepository`.

### Order/Reservation/Inventory services

Keep ownership of their respective state transitions. When a normalized
payment outcome requires changes across these records, pass the same
transaction-scoped `EntityManager` through the existing lifecycle
functions and preserve the established lock order: Payment → Order →
Reservation → Inventory (inventory rows sorted consistently).

## 4. Configuration and provider selection

-   `PAYMENT_PROVIDER` selects the provider for new payment attempts.
-   Stripe is the initial production gateway.
-   Local simulation may be retained for development/testing if it
    already exists in the project.
-   Stripe secrets and webhook secret are required and validated at
    startup only when Stripe is selected.
-   Never log secret values.
-   Unsupported provider values must fail clearly.
-   Persist the selected provider with the Payment so later webhooks are
    routed to the provider that created that payment.

## 5. Checkout and payment lifecycle

### 5.1 Order transaction and pending payment

1.  The Order checkout flow validates the cart and computes the
    authoritative total from server-side data.
2.  It creates the pending Order and Reservation and performs the
    inventory reservation in the first database transaction.
3.  Commit that transaction.
4.  After commit, create a pending Payment record associated with the
    persisted Order.
5.  Ask `PaymentProviderFactory` for the configured provider strategy.
6.  Call the provider to create the Checkout Session.
7.  Persist the provider session reference and return the hosted
    checkout URL.

No gateway HTTP request may run inside a database transaction.

### 5.2 Successful checkout endpoint response

Return the order plus the payment-session link, using the project's
established response conventions. Proposed shape:

``` json
{
  "message": "Order created successfully as pending. Complete the payment process to continue.",
  "data": {
    "order": "<persisted order representation>"
  },
  "payment_session_link": "<provider checkout URL>"
}
```

The exact `data` envelope should match the existing API conventions; do
not expose secrets or trust client-supplied amounts.

### 5.3 Session-creation failure

-   Retry transient provider/session-creation failures using exponential
    backoff, with a bounded retry count and timeout.
-   Use a stable idempotency key for retries of the same logical
    payment/session-creation attempt.
-   Do not make gateway calls inside a database transaction.
-   If retries are exhausted, execute a compensating workflow in
    database transaction(s): restore the products to the customer's
    cart, mark the Order failed, mark the Payment failed, mark the
    Reservation failed/cancelled according to the existing enum/state
    model, and release reserved inventory.
-   Return a user-safe error message: "There is an issue with our
    payment provider. You can try again later."
-   Log technical details without secrets. If compensation itself fails,
    preserve enough state for safe retry/reconciliation and do not claim
    compensation succeeded.
-   Since the initial order transaction has already committed, this is
    compensation, not rollback of that already-committed transaction.

### 5.4 Session-link response on failure

Return the project's standard non-success HTTP response. Proposed
user-facing message:

``` json
{
  "message": "There is an issue with our payment provider. You can try again later."
}
```

Do not return a fake or unusable session URL.

### 5.5 Payment success

-   A verified provider webhook is the authoritative trigger for
    payment-state processing; the frontend success URL is not proof of
    payment.
-   Resolve the Payment by provider + saved provider session ID (and
    validate the expected order/payment association).
-   Verify payment status, amount, and currency against persisted
    server-side records.
-   Apply Payment, Order, Reservation, and Inventory transitions
    atomically through existing service functions and one
    transaction-scoped EntityManager.
-   Decrement actual stock and release the reservation exactly once.
-   If the reservation has expired before a successful payment webhook
    is processed, recheck current stock under the established lock
    order. If stock is sufficient, proceed according to the existing
    completion workflow. If it is not sufficient, do not fulfill
    blindly; route to the project's defined reconciliation/compensation
    outcome.

### 5.6 Payment failure

-   Normalize provider failure events and transition
    payment/order/reservation/inventory using the agreed lifecycle
    functions.
-   Release reserved inventory exactly once when the order is
    definitively failed/cancelled and can no longer be paid.
-   Delayed payment methods must account for asynchronous
    success/failure events.

### 5.7 Customer cancellation

-   A browser redirect to `cancel_url` is not proof that payment failed
    or that the session can no longer be paid.
-   Show a cancellation/pending page and query the backend for order
    status.
-   Do not release inventory solely because the customer visited the
    cancel URL. Use verified provider events, session expiry, and the
    reservation policy.

### 5.8 Frontend success page

-   The frontend success page queries the authenticated backend for the
    current order/payment status.
-   It may display "Confirming your payment" while the webhook is
    pending.
-   It never marks an order paid based only on the redirect or query
    parameters.
-   Enforce order ownership for status reads; a customer must not read
    another customer's order/payment by guessing IDs or session IDs.

## 6. Webhook security, idempotency, and persistence

-   Expose a provider webhook endpoint that does not require a customer
    JWT, because the provider calls it directly.
-   Verify Stripe's signature using the exact raw request bytes and
    configured webhook secret.
-   Normalize only supported event types; safely reject malformed
    payloads and invalid signatures.
-   Persist webhook event records with a unique constraint on provider +
    event ID.
-   Claim/process an event so concurrent duplicate deliveries cannot
    apply the same state transition twice.
-   Update event processing state and
    payment/order/reservation/inventory effects atomically where
    possible. If processing rolls back, the event must remain safely
    retryable.
-   Acknowledge successful/ignored supported events with a 2xx response;
    return a retryable non-2xx response for transient processing
    failures.
-   Duplicate events must not decrement inventory twice, restore the
    cart twice, or repeat terminal transitions.
-   Use the saved Payment provider/session reference to correlate
    callbacks. Do not trust metadata alone without validating the saved
    payment association.

## 7. Data and API requirements

Persist at minimum: - Payment's provider. - Provider Checkout Session
ID/reference. - Payment status and association to the Order. - Any
stable internal payment-attempt identifier used for idempotency. -
Webhook provider + event ID and processing status.

Add an appropriate migration and provider-scoped uniqueness/index
constraints. Session reference uniqueness must be designed for the
actual provider/model and session recreation policy.

## 8. Acceptance criteria

1.  `PAYMENT_PROVIDER` selects the correct registered strategy;
    unsupported values fail clearly.
2.  A pending Payment is associated with the persisted Order before the
    external session is requested.
3.  Stripe session creation uses the persisted server-side Order total,
    correct currency minor-unit conversion, and stable idempotency key.
4.  Successful session creation persists the provider/session reference
    and returns the session URL.
5.  Transient creation failures retry with bounded exponential backoff.
6.  Exhausted retries invoke compensation and return a user-safe error.
7.  Verified successful webhook processing confirms the payment/order
    and applies inventory effects once.
8.  Failure/expiry events follow the defined state transitions and do
    not double-release inventory.
9.  Invalid signatures are rejected.
10. Duplicate/concurrent webhook delivery produces one business
    transition.
11. Frontend redirects do not act as payment proof.
12. Customers can only read their own order/payment status.
13. Reservation expiry racing with webhook processing has deterministic,
    tested outcomes.
14. Payment refactor and Stripe webhook flow are verified against an
    existing pending order before checkout-facade integration is
    started.

## 9. Decisions still requiring confirmation

-   Exact maximum retry count, initial delay, maximum delay, and total
    retry window.
-   Exact HTTP status code and envelope for gateway failure, matching
    the project's API conventions.
-   If stock is insufficient when a success webhook arrives after
    reservation expiry, choose the explicit reconciliation outcome
    (e.g. refund/manual review) rather than silently failing or
    fulfilling.
-   Confirm the existing Reservation terminal status name (`FAILED`,
    `CANCELLED`, or another enum value) and whether Payment failure can
    be retried on the same record or requires a new payment attempt.
