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

## inventory (no API — Partial)

- `inventory.module.ts` — provides `InventoryService`.
- `inventory.service.ts` —
  - `decreaseStockForOrderMany(manager, products)` — decrement `stock` by
    `soldQuantity` via the passed `EntityManager` (caller owns the transaction).
  - `restoreStockForOrderMany(manager, products)` — increment `stock` (refund/
    cancel).
  - `checkAvailability(productId, neededQuantity)` — **logic is inverted** (it
    throws when stock *is* sufficient); flagged as a bug in `docs/decisions/`.
  - `increaseStock()`, `checkAvailabilityMany()` — empty stubs.
- **No `Inventory` entity yet.** The service mutates `Product.stock` directly.
  The intended entity/model is in
  [`inventory-reservation.md`](./inventory-reservation.md).
