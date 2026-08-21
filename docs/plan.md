# Mini E-Commerce Backend — Architecture & Implementation Plan

## 1. System Overview

This project is a **modular monolithic e-commerce backend** built with NestJS.

The system is responsible for:

* Authentication and authorization
* Users
* Products
* Cart management
* Inventory management
* Temporary inventory reservations
* Orders and order items
* Favorites
* Caching
* Background jobs
* Asynchronous notifications
* Rate limiting
* Validation
* Centralized error handling

The application runs as one backend application while maintaining strong module boundaries.

The architecture should allow individual infrastructure components such as Redis, RabbitMQ, or background workers to scale independently when necessary without prematurely turning the application into microservices.

---

# 2. Technology Stack

| Concern                   | Technology                                        |
| ------------------------- | ------------------------------------------------- |
| Runtime                   | Node.js                                           |
| Framework                 | NestJS                                            |
| Language                  | TypeScript                                        |
| Database                  | PostgreSQL                                        |
| ORM                       | TypeORM                                           |
| Cache / distributed state | Redis                                             |
| Message broker            | RabbitMQ where asynchronous messaging is required |
| Background jobs           | BullMQ where appropriate                          |
| Authentication            | JWT                                               |
| Containers                | Docker / Docker Compose                           |
| API                       | REST                                              |
| Validation                | NestJS ValidationPipe / class-validator           |
| Testing                   | Jest + integration/E2E testing                    |

Do not introduce another backend framework.

The project is a NestJS modular monolith.

---

# 3. High-Level Architecture

```text
                    ┌─────────────────────┐
                    │       Client        │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │     NestJS API      │
                    │   Modular Monolith  │
                    └──────────┬──────────┘
                               │
       ┌───────────────────────┼────────────────────────┐
       │                       │                        │
       ▼                       ▼                        ▼
 ┌──────────┐           ┌─────────────┐          ┌───────────┐
 │  Auth    │           │   Product   │          │   Cart    │
 └──────────┘           └─────────────┘          └───────────┘
       │                       │                        │
       │                       ▼                        ▼
       │                ┌─────────────┐          ┌───────────┐
       │                │  Inventory  │◄─────────│   Order   │
       │                └──────┬──────┘          └─────┬─────┘
       │                       │                       │
       │                       ▼                       ▼
       │                ┌─────────────┐         ┌─────────────┐
       └───────────────►│ Reservation │◄────────│ Order Items │
                        └─────────────┘         └─────────────┘

                               │
                               ▼
                       ┌──────────────┐
                       │  PostgreSQL  │
                       └──────────────┘

        ┌─────────────────────────────────────────────┐
        │ Redis / RabbitMQ / BullMQ                   │
        │                                             │
        │ Cache • Rate Limiting • Background Jobs     │
        │ Async Notifications / Events                │
        └─────────────────────────────────────────────┘
```

The database is the source of truth for transactional business state.

Redis and message queues must not become accidental sources of truth for inventory or orders.

---

# 4. Module Structure

The application should follow NestJS module boundaries.

Expected modules include:

```text
src/
├── auth/
├── users/
├── products/
├── inventory/
├── reservations/
├── cart/
├── orders/
├── favorites/
├── notifications/
├── common/
├── config/
└── infrastructure/
```

The exact structure should follow the existing repository where possible.

Do not reorganize unrelated modules merely for stylistic reasons.

---

# 5. Product

The Product module owns product information.

Example conceptual entity:

```text
Product
-------
id
title
description
note
price
created_at
updated_at
```

Product information does not represent inventory state.

Inventory is a separate concern.

---

# 6. Inventory

Inventory represents the **current stock state** of a product.

Conceptual entity:

```text
Inventory
---------
id
product_id
stock
reserved_amount
available
created_at
updated_at
```

Where:

```text
available = stock - reserved_amount
```

`available` should be derived rather than independently maintained whenever possible.

The important source-of-truth fields are:

```text
stock
reserved_amount
```

Do not maintain three independent mutable values.

The system must maintain the invariant:

```text
0 <= reserved_amount <= stock
```

---

# 7. Inventory Responsibilities

The Inventory module is responsible for:

* Reading inventory
* Checking availability
* Reserving inventory
* Releasing reserved inventory
* Converting reserved inventory into sold inventory
* Increasing stock
* Decreasing stock when an order is completed
* Protecting inventory from concurrent updates

The Inventory module should expose business operations rather than allowing arbitrary modules to directly modify `stock` or `reserved_amount`.

Examples:

```text
checkAvailability()
reserve()
releaseReservation()
completeSale()
increaseStock()
decreaseStock()
```

The exact method names should follow the existing codebase conventions.

---

# 8. Reservation

Reservation represents a **temporary claim on inventory**.

A reservation must have an expiration time.

Conceptual model:

```text
Reservation
-----------
id
user_id
order_id nullable
status
expires_at
created_at
updated_at
```

For a reservation containing multiple products, use:

```text
Reservation
-----------
id
user_id
order_id nullable
status
expires_at

ReservationItem
---------------
id
reservation_id
inventory_id
quantity
```

This is preferred when a single checkout/reservation can contain multiple products.

Conceptually:

```text
Reservation
     │
     ├── Product A × 2
     ├── Product B × 1
     └── Product C × 4
```

Each reservation item references inventory rather than duplicating product inventory logic.

---

# 9. Reservation States

Keep reservation states explicit and limited.

Recommended states:

```text
RESERVED
COMPLETED
EXPIRED
CANCELLED
```

State transitions:

```text
                 ┌──────────────┐
                 │   RESERVED   │
                 └──────┬───────┘
                        │
          ┌─────────────┼──────────────┐
          │             │              │
          ▼             ▼              ▼
     COMPLETED       EXPIRED       CANCELLED
```

Do not create unnecessary statuses such as `waiting`, `pending`, and `active` unless the business requirements require them.

---

# 10. Reservation Expiration

Expiration is determined by:

```text
expires_at <= current_time
```

The `expires_at` field is the source of truth.

A background job / scheduled cleanup process should periodically find expired reservations.

Conceptually:

```sql
WHERE status = 'RESERVED'
AND expires_at <= NOW()
```

For each expired reservation:

1. Lock the relevant inventory.
2. Verify the reservation is still active.
3. Decrease `inventory.reserved_amount`.
4. Mark reservation as `EXPIRED`.
5. Commit the transaction.

The cleanup job is a **reconciliation/cleanup mechanism**.

The system must not assume that a reservation is valid merely because the cron job has not processed it yet.

---

# 11. Reservation Creation

Creating a reservation must be transactional.

Conceptual process:

```text
BEGIN TRANSACTION

        │
        ▼
Lock inventory row
        │
        ▼
Calculate available stock
        │
        ▼
Is requested quantity available?
        │
       / \
     NO   YES
     │     │
     ▼     ▼
 Reject   Increase reserved_amount
             │
             ▼
        Create reservation
             │
             ▼
        Create reservation items
             │
             ▼
          COMMIT
```

The inventory row must be protected from concurrent reservation requests.

Use PostgreSQL row-level locking where appropriate, for example:

```sql
SELECT ...
FROM inventory
WHERE id = ?
FOR UPDATE;
```

This prevents two concurrent checkout requests from both seeing the same available inventory and overselling it.

---

# 12. Example Concurrency Scenario

Suppose:

```text
stock = 10
reserved_amount = 8
available = 2
```

Two users simultaneously request:

```text
User A → 2 units
User B → 2 units
```

The system must not allow both requests to succeed.

Transaction A locks the inventory row:

```text
available = 2
```

A reserves 2:

```text
reserved_amount = 10
available = 0
```

Transaction A commits.

Transaction B then obtains the lock and sees:

```text
available = 0
```

Therefore:

```text
User B → insufficient inventory
```

This is required to prevent overselling.

---

# 13. Order Architecture

The Order module owns orders and order items.

Conceptual model:

```text
Order
-----
id
user_id
status
total
created_at
updated_at

OrderItem
---------
id
order_id
product_id
quantity
unit_price
```

The order should preserve the price at the time of purchase.

Do not rely on the current Product price when displaying historical orders.

---

# 14. Checkout Flow

Checkout should not be implemented as a chain of unrelated operations.

The critical inventory/order operations should be coordinated transactionally.

Conceptual flow:

```text
Client
  │
  ▼
Auth
  │
  ▼
Cart
  │
  ▼
Checkout
  │
  ▼
Create / validate reservation
  │
  ▼
Reserve inventory
  │
  ▼
Create order
  │
  ▼
Create order items
  │
  ▼
Commit transaction
  │
  ▼
Publish asynchronous event/job
  │
  ▼
Notifications
```

The exact flow depends on whether inventory is reserved when the cart is created, when checkout starts, or at another explicitly defined business stage.

This decision must be documented in the feature specification before implementation.

---

# 15. Reservation vs Order Completion

Do not confuse:

```text
Reservation
```

with:

```text
Sale
```

A reservation means:

> This inventory is temporarily unavailable to other users.

A completed order means:

> The inventory has been sold.

When an order/payment is successfully completed:

```text
stock -= quantity
reserved_amount -= quantity
```

Therefore:

```text
Before:
stock = 10
reserved = 3
available = 7

After sale:
stock = 7
reserved = 0
available = 7
```

The inventory quantity available for future customers remains correct.

---

# 16. Reservation Expiration

If a reservation expires before successful order completion:

```text
reserved_amount -= reservation.quantity
```

The actual stock does not change.

Example:

```text
Before:
stock = 10
reserved = 3
available = 7

Reservation expires:

stock = 10
reserved = 0
available = 10
```

The product was never sold.

---

# 17. Order Cancellation

Order cancellation must define what happens to inventory.

For an order that has already converted a reservation into a sale:

```text
stock += quantity
```

If cancellation occurs while inventory is still reserved:

```text
reserved_amount -= quantity
```

The exact behavior must depend on the order state.

Do not implement cancellation without defining the order state transition rules.

---

# 18. Database Transactions

Transactions are mandatory for operations that change multiple pieces of related business state.

Examples:

### Creating a reservation

```text
Inventory update
+
Reservation creation
+
Reservation items
```

must be atomic.

### Completing an order

```text
Order update
+
Inventory update
+
Reservation update
```

must be coordinated so the system cannot end in an inconsistent state.

If one operation fails, the relevant transactional changes must roll back.

---

# 19. RabbitMQ / Background Processing

RabbitMQ should not be placed unnecessarily inside the critical inventory transaction.

Avoid:

```text
Checkout
   ↓
RabbitMQ
   ↓
Inventory update
   ↓
Order
```

for the core consistency path.

Instead:

```text
Database Transaction
       │
       ▼
Commit
       │
       ▼
Publish Event / Background Job
       │
       ▼
Notification / Other asynchronous processing
```

The database transaction should establish the authoritative business state first.

RabbitMQ is appropriate for asynchronous communication such as:

* Order-created events
* Notifications
* External integrations
* Non-critical downstream processing

---

# 20. Background Jobs

Background processing can be used for:

### Reservation Cleanup

Periodically find:

```text
RESERVED
AND expires_at <= NOW()
```

and release the inventory.

### Notifications

After order creation/completion:

```text
Order event
    ↓
Notification worker
    ↓
Email / other notification
```

Background jobs must be idempotent where retries are possible.

---

# 21. Redis

Redis should be treated as an infrastructure component rather than the primary database.

Possible uses:

```text
Caching
Rate limiting
Temporary state
BullMQ job storage
Distributed coordination where explicitly required
```

Example cache:

```text
product:{productId}
```

However, cache invalidation must happen when underlying product data changes.

Inventory correctness must not depend on stale Redis data.

Do not use cached inventory values as the authoritative source for reservation decisions.

---

# 22. Rate Limiting

Rate limiting should protect the API from abuse and excessive requests.

If the application runs multiple instances, rate-limit state should not be stored only in process memory.

Redis can be used as shared rate-limit storage when distributed rate limiting is required.

The rate limiter should not affect the correctness of inventory transactions.

---

# 23. API Design

Use REST endpoints following the existing NestJS conventions.

Examples:

```text
POST   /auth/login
POST   /auth/register
POST   /auth/refresh

GET    /products
GET    /products/:id

GET    /cart
POST   /cart/items
PATCH  /cart/items/:id
DELETE /cart/items/:id

POST   /orders
GET    /orders
GET    /orders/:id
POST   /orders/:id/cancel

GET    /favorites
POST   /favorites
DELETE /favorites/:id
```

Do not blindly copy these routes if the existing application already has established routes.

Existing API conventions take precedence.

---

# 24. Validation

All external input must be validated.

Validate:

* IDs
* quantities
* prices where applicable
* pagination parameters
* filters
* DTO fields

Inventory quantities must be positive integers.

Never trust quantities coming from the client.

---

# 25. Error Handling

Use appropriate HTTP errors.

Examples:

```text
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Unprocessable Entity
500 Internal Server Error
```

Inventory conflicts such as insufficient stock should normally be represented as a conflict/business error rather than a generic internal server error.

All exceptions should follow the project's centralized exception handling strategy.

---

# 26. Database Indexing

Indexes should support actual access patterns.

Important candidates include:

```text
users.email

inventory.product_id

reservation.status
reservation.expires_at

reservation.user_id

reservation.order_id

reservation_item.reservation_id

reservation_item.inventory_id

order.user_id

order_item.order_id
```

Do not blindly add indexes to every column.

Indexes should be justified by query patterns and constraints.

---

# 27. Entity Relationships

Conceptually:

```text
User
 │
 ├──────── Cart
 │            │
 │            └── CartItem ── Product
 │
 ├──────── Order
 │            │
 │            └── OrderItem ── Product
 │
 ├──────── Reservation
 │            │
 │            └── ReservationItem ── Inventory ── Product
 │
 └──────── Favorites
              │
              └── FavoriteItem ── Product
```

The ORM relationships should follow the actual ownership and lifecycle of each entity.

Do not add bidirectional relationships merely because TypeORM supports them.

Add relationships where they are useful for domain navigation and querying.

---

# 28. Important Constraints

The database should enforce important invariants where possible.

Examples:

```text
stock >= 0
reserved_amount >= 0
reserved_amount <= stock
quantity > 0
price >= 0
```

Use database constraints where appropriate rather than relying entirely on application-level validation.

---

# 29. Testing Strategy

The inventory/reservation system requires more than simple unit tests.

## Unit Tests

Test:

* Availability calculation
* Reservation state transitions
* Expiration rules
* Inventory business methods
* Validation

## Integration Tests

Test:

* PostgreSQL transactions
* Reservation creation
* Reservation expiration
* Inventory release
* Order completion
* Database constraints

## Concurrency Tests

Explicitly test scenarios such as:

```text
Two users reserve the final available quantity simultaneously.
```

The system must not oversell.

## E2E Tests

Test the complete flow:

```text
Register/Login
    ↓
Add product to cart
    ↓
Checkout
    ↓
Reservation
    ↓
Order
    ↓
Completion
```

Also test:

```text
Reservation
    ↓
Expiration
    ↓
Inventory released
```

---

# 30. Documentation Structure

Maintain AI and human-readable documentation using:

```text
AGENTS.md

docs/
├── architecture/
│   ├── overview.md
│   ├── modules.md
│   ├── inventory.md
│   ├── reservations.md
│   └── order-flow.md
│
├── database/
│   ├── overview.md
│   └── relationships.md
│
├── decisions/
│   └── README.md
│
└── api/
    └── conventions.md
```

Use the existing Spec Kit structure in addition to this documentation where applicable.

Do not duplicate the same architecture information in multiple locations unnecessarily.

---

# 31. Spec-Driven Development

All significant features should follow:

```text
Requirement
     ↓
Specification
     ↓
Clarification
     ↓
Design
     ↓
Implementation Plan
     ↓
Implementation
     ↓
Tests
     ↓
Verification
```

For example, the Inventory/Reservation feature should first define:

* What creates a reservation?
* How long does it last?
* When is inventory reserved?
* When is inventory sold?
* What happens when payment fails?
* What happens when payment succeeds?
* What happens when a reservation expires?
* What happens when an order is cancelled?
* How is concurrency handled?
* What happens if the cleanup job fails?
* What happens if a worker retries?
* What happens if the API crashes during checkout?

These decisions belong in the specification before implementation.

---

# 32. Architecture Principles

The project should follow these principles:

### Database is the source of truth

PostgreSQL owns transactional business state.

### Inventory is strongly consistent

Inventory reservation must use transactions and concurrency control.

### Reservation has its own lifecycle

A reservation is not simply a field on Product or Inventory.

### Expiration is explicit

Use `expires_at`.

### Background jobs are asynchronous

They should not replace transactional consistency.

### Redis is not authoritative

Redis may be unavailable without corrupting the inventory model.

### Queue failures must be recoverable

Asynchronous processing must tolerate retries.

### Modules own their business logic

Other modules should call business services instead of directly mutating another module's database entities.

### Prefer simple architecture

This is a modular monolith.

Do not introduce microservices unless there is a demonstrated requirement.

---

# 33. Current Priority

The immediate architectural priority is:

```text
1. Inventory entity/module
2. Reservation entity/module
3. Reservation items if required
4. Transaction-safe inventory reservation
5. Reservation expiration
6. Order integration
7. Order completion
8. Cancellation/release
9. Background cleanup
10. Tests
```

Do not implement all of these at once.

Use Spec-Driven Development to specify and implement each capability incrementally.

---

# 34. What Must NOT Be Assumed

The following decisions are intentionally not hardcoded until requirements are specified:

* Exact reservation duration
* Whether inventory is reserved when adding to cart or only during checkout
* Payment provider
* Exact order status state machine
* Exact notification providers
* Exact RabbitMQ exchange/queue topology
* Exact cache TTLs
* Whether RabbitMQ or BullMQ is preferred for each background workload

These should be decided based on the feature requirements and infrastructure already present in the repository.

---

# 35. Final Architecture

The core business model is:

```text
                    PRODUCT
                       │
                       │
                       ▼
                  INVENTORY
              ┌────────┴────────┐
              │                 │
            stock         reserved_amount
              │                 │
              └────────┬────────┘
                       │
                       ▼
                   available
                       │
                       │
                       ▼
                 RESERVATION
                       │
                 ReservationItem
                       │
                       ▼
                   ORDER
                       │
                  OrderItem
                       │
                       ▼
                 COMPLETED SALE
```

The key invariant is:

```text
available = stock - reserved_amount
```

The key consistency rule is:

```text
Reservation + Inventory update
must be atomic.
```

The key expiration rule is:

```text
expires_at determines expiration.
```

The key concurrency rule is:

```text
Inventory reservation must be protected by database locking/transactional concurrency control.
```

The key architectural rule is:

```text
Keep the application as a modular monolith.
Use PostgreSQL for transactional state.
Use Redis and queues for infrastructure/asynchronous concerns.
Do not introduce distributed complexity without a requirement.
```