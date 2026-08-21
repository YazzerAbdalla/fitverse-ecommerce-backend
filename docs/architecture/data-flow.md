# Architecture — Data Flow

## Request flow (typical REST)

```text
HTTP request
  → main.ts global ValidationPipe   (whitelist + forbidNonWhitelisted + transform)
  → Controller (thin: parse + @Auth/@CurrentUser)
  → Service (business logic)
       → Repository / DataSource (PostgreSQL)
  → Service returns domain object
  → Controller returns it
  → AllExceptionsFilter serializes errors → { statusCode, message, timestamp }
```

GraphQL requests follow the same pipe/filter but resolve via
`ProductsResolver` and surface errors as `GraphQLError` with `extensions.code`
(still through `AllExceptionsFilter`).

## Cache flow (products list)

```text
GET products(page,limit)
  → key = products:list:{page}:{limit}
  → cache HIT  → return cached { data, meta }
  → cache MISS → query PostgreSQL (findAndCount, stock > 0)
               → store in Redis (TTL from CacheModule, 60s)
               → return
```
Cache invalidation is **not yet implemented** on product mutation — open question
in `docs/decisions/`.

## Async notification flow

```text
Service writes business state to PostgreSQL (transaction commits)
  → ClientsModule NOTIFICATION_SERVICE (RabbitMQ) publishes event
  → microservice consumer (future) sends notification
```
RabbitMQ is **after** the DB commit (see `docs/plan.md` §19). It is never inside
the inventory/order consistency path.

## Intended checkout / reservation flow (NOT yet implemented)

Designed in [`inventory-reservation.md`](./inventory-reservation.md) and
`docs/plan.md` §14. Summary:

```text
Client → Auth → Cart → Checkout
  → BEGIN TRANSACTION
       lock inventory (pessimistic_write)
       check available = stock - reserved_amount
       if insufficient → ConflictException (rollback)
       create Reservation (+ ReservationItems)
       increase reserved_amount
  → COMMIT
  → create Order (+ OrderItems)         (separate or same transaction per spec)
  → publish RabbitMQ event
  → (later) complete sale: stock -= qty; reserved_amount -= qty
  → (cron) expire reservations: reserved_amount -= qty; status = EXPIRED
```
The exact stage at which inventory is reserved (cart add vs checkout) is an **open
question** decided in the specification, not in code.
