# Payment Provider Refactor Plan

**Status:** Proposed
**Scope:** Define the end-state checkout/session/webhook flow and separate payment persistence from gateway behavior. Stripe may be delivered in a later phase; the checkout response contract is part of the implementation specification.

## Current State

- `PaymentService` handles API-level payment rules, payment reads/writes, transaction creation, and simulated outcomes.
- It injects both `DataSource` and `Repository<Payment>`. Intent/confirm/cancel use `DataSource.transaction()` and transaction-scoped repositories; reads use the injected repository.
- Confirm and cancel must remain atomic with order, reservation, and inventory changes. The order completion/cancellation services currently accept the enclosing `EntityManager`.
- `src/modules/payment/strategies/local-simulation.strategy.ts` and `stripe.strategy.ts` exist as empty stubs; the latter currently exports the misspelled class `StripStrategy`.
- There is no payment factory or explicit gateway contract yet.

## Goals

1. Make `PaymentService` the payment use-case/data-coordination service, using TypeORM's injected `Repository<Payment>` for ordinary data access and no custom repository class.
2. Put provider-specific behavior behind a payment strategy contract. Implement the current behavior in `LocalSimulationStrategy`.
3. Add a `PaymentFactory` that selects the configured strategy, keeping provider selection out of controllers and payment lifecycle rules.
4. Keep `PaymentService` responsible for saving the payment transaction and any provider session identifiers/results returned by the selected strategy.
5. Preserve all current endpoint behavior, payment/order state transitions, ownership checks, idempotency, error semantics, and lock ordering.
6. Make adding Stripe a focused extension, without implementing Stripe in this refactor.

## Proposed Responsibilities

```text
PaymentController
    ↓
PaymentService (payment use cases and lifecycle rules; injected Repository<Payment>)
    ├── PaymentFactory → PaymentStrategy (provider-specific gateway operation)
    ├── OrderCompletionService / OrderCancellationService
    └── transaction-owning facade
          └── transaction callback passes one EntityManager through all flow functions
```

### `PaymentService`

- Own payment use cases: create intent, confirm, cancel, get, and list.
- Enforce owner access, valid state transitions, one-payment-per-order behavior, and idempotent replay rules.
- Use the injected TypeORM `Repository<Payment>` for ordinary payment reads and writes. Do not inject or call `DataSource`, and do not introduce a custom PaymentRepository class.
- Keep transaction-dependent work in separate functions that accept the transaction `EntityManager` passed by the outer callback. Use `manager.getRepository(Payment)` for writes participating in that transaction; do not use the injected repository for those writes.
- Coordinate persistence and gateway operations; save provider session/transaction details through the appropriate transaction-scoped or injected TypeORM repository.
- Do not build TypeORM query-builder chains in the service.

### `PaymentStrategy` contract

- Define a small, provider-neutral interface for creating/confirming/cancelling a provider operation as required by the current use cases.
- Use typed request/result objects that represent provider outcome and provider session/transaction references; do not expose TypeORM entities or HTTP DTOs to strategies.
- `LocalSimulationStrategy` implements the existing deterministic demo outcomes and introduces no network calls.
- Keep order, reservation, inventory, user ownership, and payment persistence rules outside strategy implementations.
- Rename the empty `StripStrategy` stub to `StripeStrategy` in the Stripe implementation phase; do not add Stripe SDK/configuration in this refactor.

### `PaymentFactory`

- Resolve the strategy from a typed provider selection/configuration value.
- Register strategies through Nest dependency injection; avoid constructing strategies with `new` or duplicating provider selection in the service.
- Define startup behavior for an unknown/unconfigured provider explicitly (fail fast with a clear configuration error).
- Keep the current default provider as `simulation` so existing behavior is preserved.

### Transaction ownership and callback flow

- Preserve the current all-or-nothing behavior for payment + order + reservation + inventory.
- The outer facade owns transaction start/commit/rollback and invokes transaction-dependent flow functions through a callback that supplies its `EntityManager`.
- Pass the same manager to every payment, order, reservation, and inventory function that participates in the transaction.
- The Order module's facade remains responsible for starting, coordinating, and committing the order checkout flow after all callback operations finish.
- For payment confirm/cancel flows, identify the owning facade/use case and apply the same outer-facade plus manager-callback pattern. The transaction owner may use `DataSource.transaction()` internally, but `PaymentService` itself must not.
- Transaction-scoped payment writes use `manager.getRepository(Payment)` so they share the transaction; ordinary payment reads use the injected `Repository<Payment>`.
- Keep current lock ordering: intent locks Order; confirm/cancel lock Payment before downstream Order → Reservation → sorted Inventory locks. Do not call a remote provider while holding the database transaction open.

## Phases

### Phase 1 — Contract and boundary design

- Freeze the `PaymentStrategy` operations and typed result shapes from current intent/confirm/cancel behavior.
- Decide the provider selection source (configuration versus persisted `Payment.provider`) and when the factory is consulted for an existing payment.
- Define how provider session/transaction identifiers are represented and persisted. Do not add DB columns until the Stripe/session requirements are confirmed.
- Map the transaction owner for each payment use case and specify the callback functions that receive the shared `EntityManager`.

### Phase 2 — TypeORM repository usage and transaction callback refactor

- Use the injected TypeORM `Repository<Payment>` for non-transactional payment reads and writes; do not create a custom repository class.
- Extract transaction-dependent payment functions that accept the `EntityManager` callback argument.
- Ensure the owning facade starts the transaction and passes one manager through payment and order lifecycle operations; the Order facade continues to own the checkout transaction.
- Remove direct `DataSource` usage from `PaymentService` while retaining one transaction for every multi-entity mutation.
- Keep read pagination, status filtering, owner/admin read rules, and current response shapes unchanged.

### Phase 3 — Simulation strategy and factory

- Define/register `PaymentStrategy`, implement `LocalSimulationStrategy`, and add `PaymentFactory`.
- Route provider-specific simulation decisions through the selected strategy.
- Keep `PaymentService` responsible for saving payment state and provider session/transaction metadata using TypeORM Repository APIs and the passed transaction manager as appropriate.
- Correct/retire the empty strategy stubs as part of this phase; do not add Stripe network behavior.

### Phase 4 — Stripe-ready follow-up (separate feature)

- Implement `StripeStrategy` behind the same strategy contract.
- Before implementation, specify Stripe intent/session lifecycle, webhook signature verification and replay handling, monetary units/currency rules, idempotency, configuration/secrets, and persisted provider references.
- Keep Stripe network calls outside database transactions. Reconcile verified asynchronous outcomes in a short database transaction.
- Add schema changes only through a new migration and update the public API only through an approved Stripe specification.

## Behavior-Preservation Requirements

- Checkout returns the selected gateway checkout URL; define its exact response contract in the implementation specification. Preserve authorization and unrelated API contracts.
- Preserve server-derived order amount, fixed `usd` currency for simulation, and `provider: 'simulation'`.
- Preserve one payment per order, pending-intent replay, terminal intent conflict, terminal confirm idempotency, and terminal cancel conflict.
- Preserve owner-only payment writes and owner-or-admin reads.
- Preserve success/decline/cancel effects and fixed database lock ordering.
- Persist the provider checkout session reference needed to correlate callbacks/webhooks; specify its field and migration before implementation.

## Verification Plan

- Characterize existing API/state behavior before moving code, including intent replay, success, decline, cancellation, ownership, pagination, and terminal replays.
- Verify all writes and locks in a multi-entity flow use the same callback-provided transaction manager.
- Verify concurrent confirm requests still produce one state transition and one inventory mutation against real PostgreSQL.
- Verify the factory selects the simulation strategy by default and rejects unsupported providers clearly.
- Run relevant payment unit, PostgreSQL integration/concurrency, and payment E2E suites, then build and lint the touched scope.

## Open Decisions Before Implementation

1. Should strategy selection come from application configuration, or from each persisted payment's `provider` when confirming/cancelling?
2. Which provider session/reference fields are required for simulation and Stripe webhook correlation, and how should the schema store them?
3. Define webhook verification, durable replay protection, and success/failure outcome mapping before enabling Stripe.
4. Define compensation if checkout commits but session creation fails, and the race outcome when the 15-minute expiry and a payment webhook overlap.

## Out of Scope

- Implementing Stripe remains a separate delivery phase; signature verification, durable replay protection, secrets, and provider-specific schema/API changes are required before enabling it.
- Payment refunds, partial captures, new payment states, payment outbox events, or changes to order/reservation lifecycle rules.
- Replacing the existing order completion/cancellation transaction cores.

## Delivery Order and Method-Level Design

The Order checkout facade is in progress and is a later integration milestone. First finish and verify the Payment service refactor, strategies/factory, Stripe checkout session, and webhook path against an already-created pending order. Only after those are stable should the Order facade call Payment to create the session and return its link.

### Payment controller

- `createCheckoutSession`: authenticated owner route for an existing pending order. Validate the order reference, resolve correlation ID, call `PaymentService.createCheckoutSessionForOrder`, and return payment/session identifiers and checkout URL. It performs no database work and selects no provider.
- `handleStripeWebhook`: public callback route that passes the unmodified raw body and signature headers to the payment service and returns the provider-required acknowledgement. It performs no payment state mutation itself.
- `getById` and `list`: retain current owner-or-admin read behavior and delegate to service methods.
- Replace the client-driven `confirm` path for real gateways with webhook-driven outcomes. Local simulation must enter the same normalized outcome handler through its local test/simulation callback.
- Retain `cancel` only as a supported pre-payment action; specify how it interacts with provider session expiry before changing current behavior.

### Payment service — methods retained or introduced

- `createCheckoutSessionForOrder(requestingUserId, orderId, correlationId)`: validate ownership and pending order state, create/reuse the pending Payment using the persisted Order total, choose the configured provider, request a checkout URL, persist the returned provider session reference, and return the checkout result. The gateway call is outside database transactions.
- `createPendingPaymentForOrder(manager, requestingUserId, orderId)`: transaction callback method. Lock Order, check owner and PENDING state, return an existing pending Payment idempotently, reject terminal payment, or create a Payment with server-copied amount and selected provider.
- `saveCheckoutSessionReference(paymentId, sessionResult)`: persist provider/session reference using the injected TypeORM `Repository<Payment>` after gateway creation. If invoked within an existing transaction, use the passed manager's repository instead.
- `handleProviderWebhook(provider, rawBody, signatureHeaders)`: resolve the provider strategy, verify and normalize the callback, then pass the typed event into transactional processing. Unverified payload status is never trusted.
- `applyPaymentOutcome(manager, normalizedEvent)`: lock Payment first, associate it with provider/session/event, short-circuit already-terminal or duplicate events, call OrderCompletionService or OrderCancellationService with the same manager, and save the final Payment state atomically.
- `cancelPayment`: retain only for a supported pending-payment cancellation; update Payment and invoke order cancellation through the same manager callback.
- `getPaymentById` and `listPayments`: keep the current owner/admin checks, pagination, filters, and query behavior through the injected repository.
- `assertPaymentOwner`, `assertOrderOwnerForCheckout`, and `validateProviderEventAssociation`: private policy helpers for write ownership and provider/session/payment matching.
- Remove `DataSource` from PaymentService. The transaction-owning facade starts/commits/rolls back, then passes its `EntityManager` to each transaction-dependent function. No external gateway request runs inside that transaction.

### Payment transaction facade

- `runPaymentTransaction(callback)`: owns transaction start, commit, and rollback; invokes the callback with one `EntityManager`.
- Webhook outcome callbacks use that same manager for Payment lock/update, order completion/cancellation, reservation/inventory changes, and outbox writes.
- This payment transaction facade is part of the payment milestone. It is separate from the Order checkout facade that is being developed and integrated later.

### Strategy contract and implementations

- `PaymentStrategy.createCheckoutSessionLink(request)`: accepts server-calculated amount/currency plus order/payment IDs and configured return URLs; returns provider name, provider session reference, and checkout URL. It never calculates prices or persists domain state.
- `PaymentStrategy.verifyAndNormalizeWebhook(rawBody, headers)`: verifies provider authenticity and returns a typed provider-neutral event ID, session reference, outcome, and safe failure code.
- `LocalSimulationStrategy.createCheckoutSessionLink`: returns a local simulation URL/session without external network calls. Its callback/test outcome is normalized into the same event shape.
- `LocalSimulationStrategy.verifyAndNormalizeWebhook`: validates the local simulation callback contract, then returns a normalized event; it does not update entities.
- `StripeStrategy.createCheckoutSessionLink`: creates a Stripe Checkout Session with the dynamic amount received from the server, returns Stripe session ID and hosted URL, and uses a stable idempotency key for session creation. No Dashboard products or fixed Prices are used.
- `StripeStrategy.verifyAndNormalizeWebhook`: verifies `Stripe-Signature` against the untouched raw body and maps supported paid/failed/expired events to normalized outcomes. Invalid signatures are rejected.
- Neither strategy accesses Payment/Order repositories or invokes order lifecycle services.

### Payment factory

- `getStrategy(provider)`: returns the registered `simulation` or `stripe` implementation and fails clearly for an unsupported provider.
- Select the configured provider when creating a new Payment/session, persist the provider on Payment, and route later webhooks by that persisted provider.
- Keep provider branching out of controllers, Order code, and payment lifecycle logic.

### Payment data manipulation

- Ordinary Payment reads/writes use `@InjectRepository(Payment)`; transactional reads/writes use `manager.getRepository(Payment)` from the callback argument. Do not introduce a custom PaymentRepository class.
- Persist the provider checkout-session reference needed for webhook correlation. Specify its type and uniqueness/index scope before adding an additive migration.
- Add a durable provider webhook event/replay record with a PostgreSQL uniqueness constraint before enabling Stripe webhook outcomes. Mark event processing and Payment/order transitions atomically so redelivery cannot apply stock changes twice.
- Keep Payment amount/currency derived from the persisted Order at session creation; ignore any client-supplied amount. Do not store card data or secrets.

### Later Order checkout-facade integration

- Begin only after payment session creation and webhook handling are complete and verified using an existing pending order.
- The Order facade owns cart validation, authoritative total calculation, pending Order creation, 15-minute reservation, cart clearing, and its DB transaction.
- After that transaction commits, it calls the exported Payment service contract with the persisted Order ID/total and returns the checkout URL. It does not access Payment repositories or provider SDKs.
- Resolve compensation if session creation fails after order/reservation commit, and define the single-winner result when reservation expiry races a payment webhook.
