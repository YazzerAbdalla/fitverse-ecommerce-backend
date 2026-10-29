# Payment Provider Work — Junior Developer Backlog

This backlog breaks the payment roadmap into small, reviewable tasks. Work top to bottom and keep each task in its own focused change. The Order checkout-facade integration is intentionally last: first finish and verify payment refactoring and Stripe session/webhook behavior against an existing pending order.

## Working Agreements

- Pick one task at a time. Do not start a dependent task until its prerequisite is reviewed and accepted.
- Keep current payment behavior characterized before refactoring it.
- Every task that changes behavior includes tests for its acceptance criteria.
- Do not run a gateway HTTP request inside a database transaction.
- Do not use `DataSource` in `PaymentService`. Use injected TypeORM `Repository<Payment>` for normal data access and the callback-provided `EntityManager` for transaction-scoped work.
- Do not add a custom PaymentRepository class.
- Do not start the Order checkout-facade tasks until Phase C has passed review and verification.

## Phase A — Agree the Contracts and Capture the Baseline

### A-01 — Confirm payment-flow decisions

**Estimate:** 2–4 hours
**Depends on:** None

- Decide which provider is selected for a new payment and how that selection is stored for later webhook routing. ==> Stripe
- Confirm whether existing `POST /payments/intent` becomes the session-creation operation or whether the API contract changes. ==> keep it and make the session creation for the checkout
- Confirm whether the current integer amount represents whole USD or cents; document the conversion passed to Stripe. ==> Whole USD
- Decide behavior when provider session creation fails after a pending order/payment exists.
    Force the transaction to rollback all the changes 
- Confirm the 15-minute reservation clock start point and expiry-versus-webhook winner rule.
    ==> on payment success webhook event and the 15 minute reservation expired make stock recheck and if it's ok process the order 

**Done when:** the answers are written in the feature spec; no implementation task has to guess these policies.

### A-02 — Write payment-service acceptance criteria

**Estimate:** 2–3 hours -> **Started at:** 5PM Wednesday
**Depends on:** A-01

- Specify pending-payment creation, session link response, success, failure, cancellation, duplicate webhook, and owner checks.
- Specify what must be persisted for provider/session/webhook correlation.
- Mark Order checkout-facade integration as deferred.

**Done when:** a reviewer can determine expected API and database outcomes without reading implementation code.

### A-03 — Characterize current payment behavior

**Estimate:** 4–6 hours
**Depends on:** A-02

- Add/confirm tests for pending intent idempotency, terminal intent conflict, success, decline, cancel, owner authorization, list/get reads, and terminal re-confirm.
- Record which tests require PostgreSQL and which can run as unit tests.

**Done when:** current supported behavior is covered well enough to detect an accidental change during refactoring.

## Phase B — Payment Service and Strategy Refactor

### B-01 — Define provider-neutral types

**Estimate:** 2–4 hours
**Depends on:** A-02

- Define the provider enum/type, checkout-session request/result types, normalized webhook event type, and payment outcome type.
- Keep TypeORM entities and HTTP DTOs out of strategy contracts.

**Done when:** types compile and represent the simulation and Stripe use cases without `any` or provider-specific types leaking into the common contract.

### B-02 — Define the strategy interface

**Estimate:** 2–3 hours
**Depends on:** B-01

- Add `createCheckoutSessionLink(request)` to the interface.
- Add `verifyAndNormalizeWebhook(rawBody, headers)` for verified provider outcomes.
- Document required provider/session identifiers and normalized success/failure result shape.

**Done when:** the interface supports both local simulation and Stripe without requiring strategies to save entities or mutate orders.

### B-03 — Extract transaction callback operations

**Estimate:** 4–8 hours
**Depends on:** A-03

- Move transaction-dependent payment work into functions that accept the callback-provided `EntityManager`.
- Use `manager.getRepository(Payment)` for transactional locks and writes.
- Preserve the existing Payment → Order → Reservation → sorted Inventory lock order.

**Done when:** transaction-dependent operations are explicit manager-accepting functions and existing behavior tests pass.

### B-04 — Remove direct `DataSource` use from PaymentService

**Estimate:** 4–8 hours
**Depends on:** B-03

- Use injected `Repository<Payment>` for ordinary payment reads and writes.
- Move transaction start/commit/rollback to the payment transaction-owning facade.
- Pass the same manager through payment and order lifecycle functions in each transaction.

**Done when:** `PaymentService` has no `DataSource` dependency, no custom repository class was added, and transactional writes use the callback manager.

### B-05 — Implement LocalSimulationStrategy

**Estimate:** 3–5 hours
**Depends on:** B-02

- Implement a local checkout-session link without external network access.
- Normalize local success/failure callbacks into the common webhook event shape.
- Keep all payment/order persistence in services, not the strategy.

**Done when:** local simulation can create a session result and produce an outcome that enters the same payment outcome handler intended for Stripe.

### B-06 — Implement PaymentFactory

**Estimate:** 2–4 hours
**Depends on:** B-02, B-05

- Register strategies using Nest dependency injection.
- Implement `getStrategy(provider)` with a clear error for an unsupported provider.
- Select the configured provider for new payments and use the persisted Payment provider for later callbacks.

**Done when:** tests prove simulation selection, provider-specific lookup, and unknown-provider failure.

### B-07 — Wire payment service to strategy and factory

**Estimate:** 3–5 hours
**Depends on:** B-04, B-05, B-06

- Add `createCheckoutSessionForOrder(...)` orchestration for an existing pending order.
- Keep amount sourced from persisted `Order.total`; save provider and session reference.
- Return a typed checkout result to the controller.

**Done when:** an existing pending order can obtain a local checkout link and the corresponding pending Payment is persisted.

### B-08 — Verify refactored simulation flow

**Estimate:** 4–6 hours
**Depends on:** B-07

- Run unit tests and add missing strategy/factory/service tests.
- Run PostgreSQL tests for transaction rollback and concurrent payment outcome handling.
- Compare behavior against A-03 characterization criteria.

**Done when:** payment refactor is reviewed and verified before Stripe work begins.

## Phase C — Stripe Checkout Session and Webhook

### C-01 — Add validated Stripe configuration

**Estimate:** 2–4 hours
**Depends on:** B-08

- Add secret key, webhook secret, and success/cancel URL configuration through the project config pattern.
- Validate required settings at startup when Stripe is selected; never log secret values.

**Done when:** Stripe mode fails clearly on missing/invalid configuration and simulation mode still boots without Stripe secrets.

### C-02 — Add provider session persistence

**Estimate:** 3–5 hours
**Depends on:** A-01, B-08

- Add the agreed provider session reference to Payment.
- Add an additive migration and a justified uniqueness/index constraint.
- Confirm provider-scoped uniqueness and behavior for session recreation.

**Done when:** migration up/down is reviewed and the session reference can be queried efficiently and unambiguously.

### C-03 — Implement dynamic Stripe Checkout Session creation

**Estimate:** 4–8 hours
**Depends on:** C-01, C-02

- Create a one-time Checkout Session using the amount supplied from the persisted Order total.
- Convert the stored amount to Stripe's required currency minor unit according to A-01.
- Do not require products or fixed prices in the Stripe Dashboard.
- Use a stable idempotency key and persist the returned Stripe session ID and URL result.

**Done when:** Stripe test mode returns a hosted checkout URL for an existing pending order and the persisted amount/session match the server-side order.

### C-04 — Preserve raw webhook request body

**Estimate:** 2–4 hours
**Depends on:** C-01

- Configure the Nest request path to make the untouched raw body available to Stripe signature verification.
- Keep the change scoped so normal JSON parsing and unrelated routes keep working.

**Done when:** a test can verify a valid Stripe signature against the exact received bytes and rejects a modified body.

### C-05 — Add durable webhook event/replay persistence

**Estimate:** 3–6 hours
**Depends on:** A-01, C-02

- Add the event record needed to deduplicate provider event IDs.
- Add a database uniqueness constraint for provider + event ID.
- Define event claim/processed behavior for transaction rollback and redelivery.

**Done when:** concurrent duplicate deliveries cannot both apply the same event, and a failed processing transaction can be safely retried.

### C-06 — Implement Stripe webhook normalization

**Estimate:** 3–6 hours
**Depends on:** B-02, C-04

- Verify Stripe signatures using the configured webhook secret.
- Normalize only supported success/failure/expired events.
- Reject unknown or malformed payloads safely; do not trust browser redirects as payment proof.

**Done when:** unit tests cover valid signature, invalid signature, supported outcomes, unsupported event, and malformed payload.

### C-07 — Add webhook controller endpoint

**Estimate:** 2–4 hours
**Depends on:** C-06

- Add the provider callback route with no user JWT requirement.
- Pass raw bytes/signature headers to PaymentService and return a correct acknowledgement/error status.
- Keep controller free of payment business logic and database writes.

**Done when:** endpoint tests prove valid events reach the service and invalid signatures are rejected.

### C-08 — Apply normalized outcomes atomically

**Estimate:** 4–8 hours
**Depends on:** B-04, C-05, C-06

- Claim/deduplicate the event and lock Payment in the payment transaction facade.
- Validate provider/session/payment association.
- On success, call existing order completion flow with the same `EntityManager`.
- On failure, call existing order cancellation/failure flow with the same manager.
- Update Payment and event processing state atomically.

**Done when:** duplicate webhooks cause one Payment transition and one inventory effect; rollback leaves the event retryable.

### C-09 — Verify Stripe end to end against an existing order

**Estimate:** 4–8 hours
**Depends on:** C-03, C-07, C-08

- Use Stripe test mode/CLI to create a hosted session for an existing pending order.
- Verify paid and failed event paths, signature rejection, duplicate event delivery, and database state.
- Verify reservation/inventory/order state after each outcome.

**Done when:** the payment refactor and Stripe session/webhook path pass review and are demonstrated independently of the new checkout facade.

## Phase D — Order Checkout-Facade Integration (Later)

Start this phase only after Phase C is complete and accepted.

### D-01 — Finalize checkout request/response contract

**Estimate:** 2–3 hours
**Depends on:** C-09

- Specify how the checkout response adds the payment URL and payment/session references.
- Specify failure response/compensation behavior if the gateway cannot create a session.

**Done when:** frontend and backend expectations agree and no amount is accepted from the client.

### D-02 — Connect the Order facade to PaymentService

**Estimate:** 4–8 hours
**Depends on:** D-01

- Preserve Order facade ownership of cart validation, authoritative total, pending order, reservation, cart clear, and DB transaction.
- After commit, call the exported payment service contract to create the provider session.
- Return the checkout URL with the order response.
- Do not inject payment repositories or Stripe clients into Order code.

**Done when:** checkout creates the order/reservation, returns the session link, and all values come from the persisted server-side order.

### D-03 — Handle session-creation failure after checkout commit

**Estimate:** 3–6 hours
**Depends on:** D-02

- Implement the A-01 agreed compensation or retry behavior.
- Ensure failed session creation does not leave a reservation/payment in an undocumented state.

**Done when:** a simulated gateway failure produces the agreed recoverable state with no leaked inventory hold.

### D-04 — Resolve reservation expiry versus webhook race

**Estimate:** 3–6 hours
**Depends on:** D-02

- Enforce the 15-minute reservation TTL using the agreed start point.
- Ensure expiry and webhook outcome use compatible locks and one deterministic winner.

**Done when:** PostgreSQL concurrency tests prove the order/reservation/inventory cannot be both expired and completed.

### D-05 — Full checkout-to-webhook E2E verification

**Estimate:** 4–8 hours
**Depends on:** D-03, D-04

- Verify checkout response contains the provider URL.
- Verify successful webhook completes order/reservation and sells inventory once.
- Verify failure/expiry releases reservation without selling inventory.
- Verify duplicate events, gateway failure, authorization, and 15-minute expiry behavior.

**Done when:** end-to-end acceptance criteria pass with PostgreSQL and Stripe test mode/local simulation.

## Suggested Review Checkpoints

1. **Checkpoint 1:** A-01 through A-03 accepted before production refactoring.
2. **Checkpoint 2:** B-01 through B-08 accepted before Stripe SDK or webhook implementation.
3. **Checkpoint 3:** C-01 through C-09 accepted before Order checkout-facade work begins.
4. **Checkpoint 4:** D-01 through D-05 accepted before calling the full checkout/payment flow complete.

Estimates are junior-developer task sizing, not calendar commitments. Add review time and environment setup separately; tasks that uncover policy/schema decisions should stop and update the spec rather than make assumptions.
