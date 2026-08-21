# Architecture — Modules

Per-module detail. Each module lives under `src/modules/<name>/`. Follow the
existing `imports / providers / controllers / exports` shape and export any
service another module needs.

## auth (REST)

- `auth.module.ts` — imports `UsersModule`, registers `JwtModule` (global, secret
  from `ConfigService`), `PassportModule`; provides `AuthService`,
  `LocalStrategy`; exports `AuthService`.
- `auth.controller.ts` — `POST /auth/register`, `POST /auth/login`.
- `auth.service.ts` — `register` (bcrypt hash, salt 10, duplicate-email check),
  `userValidation` (bcrypt compare), `login` (sign JWT).
  - **Note:** contains a leftover `console.log` (see `docs/decisions/` open
    questions) — remove when touched.
- Guards: `JwtGuard` (verifies bearer token, sets `request.user`), `RolesGuard`
  (reflects `roles` metadata). Decorators: `Auth(...roles)` (applies both
  guards), `CurrentUser(prop?)`.
- Strategy: `local.strategy.ts` (passport-local) delegates to `AuthService.
  userValidation`.

## users (no API)

- `users.module.ts` — `TypeOrmModule.forFeature([User])`, exports
  `UsersService`.
- `users.service.ts` — `findUserByEmail`, `createNewUser`.
- `user.entity.ts` — UUID PK, `role` enum (`UserRoles`), `password` (hashed),
  relations to `Order` and `Cart`.

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
