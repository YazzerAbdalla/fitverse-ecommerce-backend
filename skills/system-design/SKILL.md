---
name: system-design
description: Reason about scalability, caching, Redis, queues, rate limiting, DB bottlenecks, concurrency, and failure handling for this e-commerce backend. Use when designing features or reviewing architecture.
---

# System Design

Read [`docs/plan.md`](../../docs/plan.md) and [`AGENTS.md`](../../AGENTS.md) for
the established direction. The system is a **modular monolith**; keep it that way
unless a requirement forces extraction.

## Principles

- **PostgreSQL is the source of truth** for all transactional business state.
- **Redis is infrastructure**, not authority — cache, future rate limiting, job
  storage. Never base inventory/reservation decisions on cached values.
- **Queues (RabbitMQ) are post-commit**: publish events *after* the DB transaction
  commits. Never put the broker inside the consistency-critical path.
- **Strong consistency for inventory**: transactions + pessimistic row locking.
- **Reservations have their own lifecycle** with explicit `expires_at`.
- **Prefer simple architecture**; avoid microservices/distributed complexity
  without a demonstrated need.

## Scalability levers (already present)

- Redis cache for hot reads (product listing).
- RabbitMQ to offload notifications/downstream work from the request path.
- Modules can be extracted to separate deployments later without rewriting the
  domain.

## Caching

- Cache list/detail reads; invalidate on mutation (currently **missing** for
  product list — open question).
- Don't cache inventory availability authoritatively.

## Rate limiting (open)

- Redis is the natural shared store for distributed limiting; strategy not yet
  chosen. Decide in a spec. Must not affect inventory transaction correctness.

## Queues / background jobs

- Notifications: order event → worker → notification (idempotent on retry).
- Reservation cleanup: cron/worker finds `RESERVED AND expires_at <= NOW()`,
  releases `reserved_amount`, marks `EXPIRED` — transactional and idempotent.

## Concurrency & failure

- Prevent overselling with `pessimistic_write` locks; `available = stock -
  reserved_amount`.
- Define explicit state transitions for reservation/order; handle payment
  success/failure, expiration, cancellation, worker retry, and crash-during-
  checkout as first-class cases (see `docs/plan.md` §15–§17, §34).
