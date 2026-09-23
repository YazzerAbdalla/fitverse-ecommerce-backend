# Architecture — Modules

Per-module detail. Each module lives under `src/modules/<name>/`. Follow the
existing `imports / providers / controllers / exports` shape and export any
service another module needs.

## auth (REST) — Phase 16

- `auth.module.ts` — imports `UsersModule`, `TypeOrmModule.forFeature([PasswordResetToken, OtpVerification])`, registers `JwtModule` (global, secret from `ConfigService`), `PassportModule({session:false})`; provides `AuthService`, `LocalStrategy`, `JwtStrategy` (tokenVersion revocation per F2 C), `GoogleStrategy` (passport-google-oauth20, state true), `RateLimitGuard` (Redis fail-open, full headers B1, `ConfigService` limits `ORDER_CHECKOUT_RL_MAX` etc, distributed `rl:` keys, outermost before `JwtGuard`); exports `AuthService` **and `RateLimitGuard`** (shared guard for `Order`/`Cart`/`Products` via `AuthModule` import).
- `auth.controller.ts` — `POST /auth/register`, `POST /auth/login` (rate-limited), plus Phase 16: `POST /auth/forgot-password` (anti-enum 200, T019), `POST /auth/validate-reset-token`, `POST /auth/reset-password` (FOR UPDATE single-winner, T021 tokenVersion increment), `POST /auth/otp/request` (public+JwtGuard, T032 hybrid BullMQ, cooldown 60s), `POST /auth/otp/verify` (Q4 fallback, every-attempt B2, T033), `GET /auth/google` (302, GoogleAuthGuard), `GET /auth/google/callback` (JSON per Q5), `GET /auth/google/link` (JwtAuthGuard+GoogleAuthGuard).
- `auth.service.ts` — `register` (bcrypt 10, duplicate check, Logger.debug), `userValidation` (handles `password IS NULL` → null per pure OAuth), `login` (signs `{sub,email,fullName,role,tokenVersion}`), plus `requestPasswordReset` (sha256, 15m, invalidate priors, hybrid RabbitMQ), `validateResetToken`, `resetPassword` (bcrypt + tokenVersion increment, single-winner), `requestWhatsAppOtp`/`verifyWhatsAppOtp` (crypto.randomInt, sha256, Redis+PG fallback, 3 attempts, 60s cooldown, WhatsAppProvider), `handleGoogleLogin`/`linkGoogleAccount` (auto-link verified email Q1, password null).
- DTOs: `forgot-password.dto.ts`, `reset-password.dto.ts` (Min 8 Max 72), `validate-reset-token.dto.ts`, `request-otp.dto.ts` (`@Matches E.164`, optional phone when authed per C1), `verify-otp.dto.ts` (`@Length 6`).
- Entities: `password-reset-token.entity.ts` (FK CASCADE, CHECK expiresAt>createdAt), `otp-verification.entity.ts` (purpose login|verify_phone, CHECK attempts<=3, Q4 fallback).
- Providers: `whatsapp.provider.ts` (interface + Noop/Twilio/Meta per D6).
- Guards: `JwtAuthGuard` (AuthGuard jwt, checks tokenVersion), `GoogleAuthGuard`, `RateLimitGuard` (per-route limits, Retry-After + X-RateLimit-* per B1, fail-open metric, dual `10+5/h` for `POST /auth/refresh`), plus existing `JwtGuard` (manual) now delegated to `JwtStrategy`, `RolesGuard` retained.
- Strategies: `local.strategy.ts` (passport-local), `jwt.strategy.ts` (passport-jwt, tokenVersion vs passwordChangedAt fallback), `google.strategy.ts` (passport-google-oauth20, scope profile email, validate maps profile → GoogleProfile).
- **Phase 17 Refresh Token** — `refresh-token.entity.ts` (`RefreshToken` PG `tokenHash sha256`, `expiresAt 7d CHECK`, `revokedAt`, partial `UQ tokenHash WHERE revokedAt IS NULL`, cap 5 LRU, migration `1755900000005-CreateRefreshToken`); `refresh-token.dto.ts` (`@Matches 64hex`); `auth.service.ts` `login` + `handleGoogleLogin` now issue `{accessToken 15m, refreshToken 64hex}+Set-Cookie: refresh_token HttpOnly Secure SameSite=Strict Path=/auth`, `refresh(raw)` `FOR UPDATE` rotation + theft bulk revoke-all + `X-Email-Unverified`, `logout` idempotent `200` + `logoutAll` `tokenVersion++` + `purgeExpiredTokens 7d`; `auth.controller.ts` `POST /auth/refresh` body|cookie dual + `POST /auth/logout` + `POST /auth/logout-all` `@Auth()` all `RateLimitGuard` outermost + `cookieParser` `resolveRefreshRaw` + `AllExceptionsFilter` `401/429`.

## users (no API) — Phase 16 altered

- `users.module.ts` — `TypeOrmModule.forFeature([User])`, exports `UsersService`.
- `users.service.ts` — `findUserByEmail`, `findUserById`, `findByGoogleId`, `updatePassword`/`incrementTokenVersion`, `createNewUser` (now `any` for OAuth null password).
- `user.entity.ts` — UUID PK, `role` enum, `password` **nullable** (pure OAuth), plus `phoneNumber` (partial unique `WHERE phoneNumber IS NOT NULL`, E.164), `phoneVerified`, `googleId` (partial unique `WHERE googleId IS NOT NULL`), `provider enum local|google` (`CHECK`), `tokenVersion int default 0` (F2 C revocation), `passwordChangedAt` nullable (compat), `emailVerified`, `UNIQUE(email)` (was only Index), relations to `Order`/`Cart` unchanged. Migration `1755900000000-AuthUpgradesUserAndResetToken` owns these per F3.

## products (GraphQL, Apollo code-first) — Phase 9 Redis / Product Caching DONE

- `products.module.ts` — `forFeature([Product])` + `forwardRef(InventoryModule)` + `AuthModule` (for `RateLimitGuard` shared), global `CACHE_MANAGER` (`@keyv/redis` ioredis, `REDIS_URL`) via `src/app.module.ts` `CacheModule` `ttl 60*1000`; exports `ProductsService`. `ConfigService` provides `PRODUCT_LIST_CACHE_TTL_MS=60000` (min 5000) / `PRODUCT_SINGLE_CACHE_TTL_MS=300000` (min 30000) with clamp + `Logger.log` on init.
- `products.resolver.ts` — thin GraphQL, mapped 1:1 to service methods (`createProduct`, `createManyProducts`, `products`→`findAll`, `product`→`findOne`, `updateProduct`, `updateMany`, `removeProduct`, `removeAllProducts`); mutations `createProduct/updateProduct/etc` throttled **30/h per admin** via `@UseGuards(RateLimitGuard)` (extracts `req` via `GqlExecutionContext`, key `rl:products:mutation:user:<admin>`, fail-open).
- `products.service.ts` — **This service is responsible for product catalog and product-cache (cache-aside).** `create`/`createMany` (slugify + unique name/slug, `InventoryService.createForProduct` 0-stock) → post-commit `invalidateAllLists()`; `findAll` cache-aside `products:list:{page}:{limit}` TTL 60s (fail-open `try/catch get` → `Cache HIT/MISS` `Logger.debug`, `set` TTL, fallback to `findAndCount` on `ECONNREFUSED`); `findOne` cache-aside `product:{id}` TTL 300s (no negative cache, fail-open); `update` → `del product:{id}` + `del products:list:*` via `store.keys('products:list:*')→del` selective + `clear()` fallback (warn if `clear()` would evict `expiration:tick:lock`); `updateMany` (`pessimistic_write` lock transactional after `manager.save` → `invalidateProductCaches(ids)` outside tx); `remove`/`resetAll` → `del product:{id}` + lists (resetAll clears `product:*` plus lists). Never caches `stock`/`available`, never inside `dataSource.transaction` (post-commit). Strictly products-only per FR-007.
- Entity carries `@ObjectType()`/`@Field()` (GraphQL) **and** TypeORM decorators.
  Has `@Check('"price" >= 0')` and `@Unique(['name'])`, `@Index(['name'])`. No `stock` field (owned by `Inventory`).

## cart (REST) — Phase 10 rate-limited

- `cart.module.ts` — imports `AuthModule` (for `RateLimitGuard` shared) + `ProductsModule` + `InventoryModule`; provides `CartService` + `Logger`.
- `cart.controller.ts` — `GET /cart` (reads not strictly throttled), writes throttled **60/h per user** shared bucket via `@UseGuards(RateLimitGuard)` outermost before `@Auth(User)`: `POST /cart`, `PATCH /cart/increase|decrease`, `DELETE /cart/:cartItemId`, `DELETE /cart` each `@ApiResponse 429`, key `rl:POST /cart:user:<sub>` (fallback IP), fail-open on `ECONNREFUSED`.
- `cart.service.ts` — find-or-create user cart, add/update/remove/clear items.
  `CartItem.product` is `eager: true`. Stock is **checked but not reserved**;
  final inventory mutation happens at checkout. `clearCart` deletes items
  fire-and-forget (not a durable job).
- DTOs: `add-cart-item.dto.ts`, `update-cart-item-quantity.dto.ts`.

## order (REST) — Phases 6-7 DONE, Phase 10 rate-limited

- `order.module.ts` — imports `AuthModule` (for `RateLimitGuard`) + `TypeOrmModule.forFeature([Order, OrderItem])` + `ReservationModule` + `CartModule` + `ProductsModule` + `InventoryModule`; providers `OrderService` + `OrderCheckoutService` + `OrderCompletionService`; exports all three.
- `order.controller.ts` — `POST /order/checkout` + alias `POST /order` throttled **10/h per user** (`@UseGuards(RateLimitGuard)` outermost before `@Auth()`), key `rl:POST /order/checkout:user:<sub>`; `POST/PATCH /order/:id/complete` throttled **10/h per user** same guard; `GET /order` + `GET /order/:id` (reads not strictly throttled); each throttled handler `@ApiResponse 429`. Checkout creates `Order PENDING + Reservation RESERVED + reservedAmount` inside `DataSource.transaction` (caller owns `EntityManager`); completion does `stock-=qty reserved-=qty` via `OrderCompletionService` (`FOR UPDATE` Order→Reservation→sorted Inventories). `429` never holds lock (spy 0 calls).
- `order.service.ts` — `findAll`/`findOne` paginated owner-scoped.
- Legacy `order.enum.ts` `FAILD` typo retained for compat, `order-status.enum.ts` holds `PENDING|COMPLETED|CANCELLED|FAILED`.

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
