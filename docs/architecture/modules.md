# Architecture — Modules

Per-module detail. Each module lives under `src/modules/<name>/`. Follow the
existing `imports / providers / controllers / exports` shape and export any
service another module needs.

## auth (REST) — Phase 16

- `auth.module.ts` — imports `UsersModule`, `TypeOrmModule.forFeature([PasswordResetToken, OtpVerification])`, registers `JwtModule` (global, secret from `ConfigService`), `PassportModule({session:false})`; provides `AuthService`, `LocalStrategy`, `JwtStrategy` (tokenVersion revocation per F2 C), `GoogleStrategy` (passport-google-oauth20, state true), `RateLimitGuard` (Redis fail-open, full headers B1), `NoopWhatsAppProvider` (`WHATSAPP_PROVIDER`); exports `AuthService`.
- `auth.controller.ts` — `POST /auth/register`, `POST /auth/login` (rate-limited), plus Phase 16: `POST /auth/forgot-password` (anti-enum 200, T019), `POST /auth/validate-reset-token`, `POST /auth/reset-password` (FOR UPDATE single-winner, T021 tokenVersion increment), `POST /auth/otp/request` (public+JwtGuard, T032 hybrid BullMQ, cooldown 60s), `POST /auth/otp/verify` (Q4 fallback, every-attempt B2, T033), `GET /auth/google` (302, GoogleAuthGuard), `GET /auth/google/callback` (JSON per Q5), `GET /auth/google/link` (JwtAuthGuard+GoogleAuthGuard).
- `auth.service.ts` — `register` (bcrypt 10, duplicate check, Logger.debug), `userValidation` (handles `password IS NULL` → null per pure OAuth), `login` (signs `{sub,email,fullName,role,tokenVersion}`), plus `requestPasswordReset` (sha256, 15m, invalidate priors, hybrid RabbitMQ), `validateResetToken`, `resetPassword` (bcrypt + tokenVersion increment, single-winner), `requestWhatsAppOtp`/`verifyWhatsAppOtp` (crypto.randomInt, sha256, Redis+PG fallback, 3 attempts, 60s cooldown, WhatsAppProvider), `handleGoogleLogin`/`linkGoogleAccount` (auto-link verified email Q1, password null).
- DTOs: `forgot-password.dto.ts`, `reset-password.dto.ts` (Min 8 Max 72), `validate-reset-token.dto.ts`, `request-otp.dto.ts` (`@Matches E.164`, optional phone when authed per C1), `verify-otp.dto.ts` (`@Length 6`).
- Entities: `password-reset-token.entity.ts` (FK CASCADE, CHECK expiresAt>createdAt), `otp-verification.entity.ts` (purpose login|verify_phone, CHECK attempts<=3, Q4 fallback).
- Providers: `whatsapp.provider.ts` (interface + Noop/Twilio/Meta per D6).
- Guards: `JwtAuthGuard` (AuthGuard jwt, checks tokenVersion), `GoogleAuthGuard`, `RateLimitGuard` (per-route limits, Retry-After + X-RateLimit-* per B1, fail-open metric), plus existing `JwtGuard` (manual) now delegated to `JwtStrategy`, `RolesGuard` retained.
- Strategies: `local.strategy.ts` (passport-local), `jwt.strategy.ts` (passport-jwt, tokenVersion vs passwordChangedAt fallback), `google.strategy.ts` (passport-google-oauth20, scope profile email, validate maps profile → GoogleProfile).

## users (no API) — Phase 16 altered

- `users.module.ts` — `TypeOrmModule.forFeature([User])`, exports `UsersService`.
- `users.service.ts` — `findUserByEmail`, `findUserById`, `findByGoogleId`, `updatePassword`/`incrementTokenVersion`, `createNewUser` (now `any` for OAuth null password).
- `user.entity.ts` — UUID PK, `role` enum, `password` **nullable** (pure OAuth), plus `phoneNumber` (partial unique `WHERE phoneNumber IS NOT NULL`, E.164), `phoneVerified`, `googleId` (partial unique `WHERE googleId IS NOT NULL`), `provider enum local|google` (`CHECK`), `tokenVersion int default 0` (F2 C revocation), `passwordChangedAt` nullable (compat), `emailVerified`, `UNIQUE(email)` (was only Index), relations to `Order`/`Cart` unchanged. Migration `1755900000000-AuthUpgradesUserAndResetToken` owns these per F3.

## products (GraphQL, Apollo code-first)

- `products.module.ts` — `forFeature([Product])`, exports `ProductsService`.
- `products.resolver.ts` — queries/mutations mapped 1:1 to service methods.
- `products.service.ts` — `create` (slugify + unique name/slug), `createMany`,
  `findAll` (offset pagination + **Redis cache** keyed
  `products:list:{page}:{limit}`), `findOne`, `update`, `updateMany`
  (**transaction + `pessimistic_write` lock**), `remove`, `resetAll`.
- Entity carries `@ObjectType()`/`@Field()` (GraphQL) **and** TypeORM decorators.
  Has `@Check('"stock" >= 0')` and `@Unique(['name'])`, `@Index(['name'])`.

## cart (REST)

- `cart.module.ts` — imports `ProductsModule` (uses `ProductsService`); provides
  `CartService` + `Logger`.
- `cart.service.ts` — find-or-create user cart, add/update/remove/clear items.
  `CartItem.product` is `eager: true`. Stock is **checked but not reserved**;
  final inventory mutation happens at checkout. `clearCart` deletes items
  fire-and-forget (not a durable job).
- DTOs: `add-cart-item.dto.ts`, `update-cart-item-quantity.dto.ts`.

## order (REST — STUB)

- `order.module.ts` — only controller + service, no `forFeature`, no exports.
- `order.controller.ts` — routes exist (`POST /order`, `GET /order`,
  `GET /order/:id`, `PATCH`, `DELETE`) but `OrderService` returns placeholder
  strings. `GET /order` is protected with `@Auth(UserRoles.User)`.
- `order.service.ts` — **stub** (`create` returns `"This action adds a new
  order"`, etc.).
- `order.enum.ts` — `OrderStatus { SUCCESS, FAILD, PENDING }`.
  - **Note:** `FAILD` is a typo and the set does not match the reservation/
    order state machine in `docs/plan.md`. Open question in `docs/decisions/`.
- `CreateOrderDto` is **empty** (`export class CreateOrderDto {}`).

## inventory (REST — Phase 1 DONE)

- `inventory.module.ts` — `TypeOrmModule.forFeature([Inventory])` + `InventorySeeder` (idempotent `onModuleInit`); exports `InventoryService`.
- `inventory.entity.ts` — `id uuid PK`, `productId FK Product CASCADE @Index + @Unique`, `stock CHECK >=0`, `reservedAmount CHECK >=0 && <=stock`, `available` derived `stock - reservedAmount` (getter), `@Check` + `@Unique` enforced; migration `1755800000000-CreateInventoryAndDropProductStock` owns DDL (`synchronize:false`).
- `inventory.service.ts` — `getInventory(productId)`, `checkAvailability(productId,qty)` (`available = stock - reservedAmount`), `increaseStock`/`decreaseStock`, `decreaseStockForOrderMany(manager, items)` / `restoreStockForOrderMany(manager, items)` via passed `EntityManager` (caller owns tx), `reserve`/`releaseReservation`/`completeSale` stubs; deterministic `FOR UPDATE` owned by reservation layer.
- `inventory.controller.ts` — thin REST `GET /inventory/:productId`, `GET .../availability?quantity=`, `POST .../increase|decrease` (admin).

## reservation (REST — Phases 2-5 DONE)

- `reservation.module.ts` — `TypeOrmModule.forFeature([Reservation, ReservationItem])`, `BullModule.registerQueue({name:'reservation-expiration'})`, provides `ReservationService` + `ReservationExpirationService` + `ReservationExpirationProcessor` + `REDIS_CLIENT` (`ioredis` lazy, `REDIS_URL` precedence `src/app.module.ts:45`), exports both services.
- `reservation.entity.ts` / `reservation-item.entity.ts` — `Reservation` `id uuid PK`, `userId FK CASCADE @Index`, `orderId FK SET NULL`, `status enum RESERVED|COMPLETED|EXPIRED|CANCELLED`, `expiresAt timestamptz` `DEFAULT_TTL_MS 15m`, `OneToMany items`; `ReservationItem` `quantity CHECK >0`, `@Unique([reservationId,inventoryId])`; indexes `userId/status/expiresAt` + composite `status+expiresAt` for scan; migration `1755850000000`.
- `reservation.service.ts` — `create(manager,userId,dto)` (`FOR UPDATE` sorted `Inventory` `In(sortedIds)`, `available>=qty`, `reserved+=qty`), `findById`/`listByUser` (paginated, admin filter), `complete`/`cancel`/`expire` via `ReservationTransitionBuilder` `src/modules/reservation/reservation-transition.builder.ts` → `transitionWithInventoryInternal` (`FOR UPDATE Reservation` first then sorted `Inventory`, `validateTransition`, idempotent `COMPLETED→COMPLETED 200`, `CANCELLED/EXPIRED→* 409`, inventory `COMPLETED: stock-=qty+reserved-=qty` vs `CANCELLED/EXPIRED: reserved-=qty` only, `CHECK 23514→409`, no external I/O inside tx); `validateTransition`/`assertOwner`.
- `reservation-transition.builder.ts` — fluent builder replacing positional `checkOwner` boolean: `new ReservationTransitionBuilder(service,manager,id).to(EXPIRED).withoutOwnerCheck().execute()`.
- `reservation-expiration.service.ts` — `findExpiredCandidateIds(limit)` `status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt,id LIMIT`, `expireOne` delegates to `service.expire`, `processExpiredBatch(limit)` (scan outside tx, loop per-candidate `dataSource.transaction`, `isQuarantined`/`incrementPoisonCount`/`setQuarantined` via Redis `expiration:poison:count/quarantine` `TTL 86400` fallback to in-memory `Map/Set`, `EXPIRATION_MAX_RETRIES=3`, `Conflict Invalid transition` → `skipped` not retried, RabbitMQ `reservation.expired` emit post-commit), `processAll` / `clearPoisonState`.
- `reservation-expiration.processor.ts` — `@Processor('reservation-expiration', concurrency:1)` `WorkerHost`, `onModuleInit` registers BullMQ repeat `30s`/`EXPIRATION_CRON` `jobId` singleton, `process` guards `EXPIRATION_ENABLED=false`, in-memory `processing` + distributed `SET expiration:tick:lock NX EX ttlSec` (`Math.ceil(interval/1000)+5`) via `REDIS_CLIENT` (skip if `skippedByLock`), then `service.processExpiredBatch(batchSize)`.
- `reservation.controller.ts` — thin `POST /reservations`, `GET /:id` (owner/admin), `GET /` (paginated), `PATCH /:id/complete|cancel` (owner/admin), `PATCH /:id/expire` (admin immediate override, no `expiresAt` check Q1) all wrap `dataSource.transaction`.
- DTOs: `create-reservation.dto.ts` (`items: {inventoryId,quantity>0}[]`, `orderId`, `expiresAt` future validated, `Global ValidationPipe` whitelist).
