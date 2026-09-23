# Tasks: Rate Limiting / Distributed Throttling

**Input**: Design documents from `/specs/010-rate-limiting/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/
**Branch**: `010-rate-limiting` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Tests**: Included per FR-009 (unit mocked `CACHE_MANAGER`, integration real Redis `FLUSHDB` or shared Map, E2E `supertest` x11/x61). Tests are REQUIRED — write failing tests before implementation per workflow.

**Organization**: Tasks grouped by user story (US1–US4) for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify base infra and create scaffolding for distributed rate limiting

- [ ] T001 Verify `CacheModule` global and `REDIS_URL` in `src/app.module.ts:36` and `.env.example`, ensure `CacheTestService` ping still logs but does not crash in `src/cache-test.service.ts`
- [ ] T002 [P] Create env placeholders for rate-limit overrides in `.env.example` (add `ORDER_CHECKOUT_RL_MAX`, `ORDER_CHECKOUT_RL_WINDOW_MS`, `ORDER_COMPLETE_RL_MAX`, `ORDER_COMPLETE_RL_WINDOW_MS`, `CART_RL_MAX`, `CART_RL_WINDOW_MS`, `PRODUCT_MUTATION_RL_MAX`, `PRODUCT_MUTATION_RL_WINDOW_MS`, `RATE_LIMIT_FAIL_OPEN_METRIC`) without hardcoding in service
- [ ] T003 [P] Confirm `AllExceptionsFilter` forwards `ex.options.headers` (`Retry-After`, `X-RateLimit-*`) for `HttpStatus.TOO_MANY_REQUESTS` in `src/filters/all-exceptions.filter.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core guard enhancements that MUST be complete before ANY user story wiring can be tested

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Extend `RateLimitGuard` in `src/modules/auth/guards/rate-limit.guard.ts` to inject `ConfigService` and `Logger`, keep existing auth `LIMITS` (forgot 5/3, reset/validate 10, otp, google 20, login/register 10) byte-equal for regression SC-008
- [ ] T005 [P] Add ConfigService-driven limits helper `getLimitsForRoute(routeKey)` in `src/modules/auth/guards/rate-limit.guard.ts` parsing `ORDER_CHECKOUT_RL_MAX` etc via `parseInt` with NaN fallback to defaults and `Logger.warn` + clamp `windowMs >= 60000` → 3600000
- [ ] T006 [P] Add deterministic key helpers `buildRateLimitKey(routeKey, dim, value)`, `extractIp(req)`, `extractEmail/Phone/User(req)` (x-forwarded-for first-value trimmed → `req.ip` → unknown, email lowercased, `req.user?.sub ?? ip` fallback) in `src/modules/auth/guards/rate-limit.guard.ts` with JSDoc `/** @param @returns */` and `//` intent comments per `AGENTS.md` §3
- [ ] T007 Add `toTooManyException(limit, windowMs)` in `src/modules/auth/guards/rate-limit.guard.ts` throwing `HttpException 429` with `options.headers { 'Retry-After': ceil(windowMs/1000), 'X-RateLimit-Limit': limit, 'X-RateLimit-Remaining':'0' }` and success path `res.setHeader('X-RateLimit-Limit', Remaining)`
- [ ] T008 Export `RateLimitGuard` from `src/modules/auth/auth.module.ts` (`exports: [AuthService, RateLimitGuard]`) and ensure `CACHE_MANAGER` + `ConfigService` providers visible to importing modules
- [ ] T009 Add class-level `/** This guard is responsible for distributed per-route rate limiting (Redis shared, fail-open) ... */` and method-level JSDoc for every public/private helper in `src/modules/auth/guards/rate-limit.guard.ts`

**Checkpoint**: Foundation ready — guard core compiled (`npm run build` passes), unit wiring independently testable in isolation

---

## Phase 3: User Story 1 — Brute-force protection on auth endpoints stays enforced (Priority: P1) 🎯 MVP

**Goal**: Keep `POST /auth/login`, `register`, `forgot-password`, `reset-password`, `validate-reset-token`, `otp/request`, `otp/verify`, `GET /auth/google/callback` throttled exactly as in `005-auth-upgrades` (SC-001/SC-002) after guard generalization

**Independent Test**: With mocked `CACHE_MANAGER` or real Redis `FLUSHDB`, `POST /auth/login` 10× same IP → 10× true with `X-RateLimit-Limit:10 Remaining:9..0`, 11th → 429 `Retry-After:3600 Limit:10`; different IP immediately → true. `POST /auth/forgot-password` same email 3× true, 4th same email 429 `Limit:3` even from different IP, while other email still true until IP 5× 6th 429 `Limit:5`. No change to `AuthService` calls on 429 path.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Unit test auth `POST /auth/login` 10→429 IP isolated in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `CACHE_MANAGER.get/set` jest.fn, `ExecutionContext` `req.method POST`, `req.route.path /auth/login`, `req.ip 1.1.1.1` + `x-forwarded-for`, `res.setHeader` spy, ConfigService defaults)
- [ ] T011 [P] [US1] Unit test `POST /auth/forgot-password` per-email 3 + per-IP 5 two-bucket in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `req.body.email`, verify two `cache.get` keys `rl:...:ip` and `rl:...:email:lc`, 4th email 429 `Limit:3`, 6th IP 429 `Limit:5`)
- [ ] T012 [P] [US1] Integration test real Redis `FLUSHDB` auth 10→429 isolation in `src/modules/auth/test/rate-limit.integration.spec.ts` (Test.createTestingModule + CacheModule shared store, call `canActivate` 11× same IP, 11th `HttpException 429`, different IP true)

### Implementation for User Story 1

- [ ] T013 [US1] Verify existing `@UseGuards(RateLimitGuard)` on `POST /auth/*` routes in `src/modules/auth/auth.controller.ts` still applied (`/register`, `/login` with `LocalAuthGuard`, `/forgot-password`, `/validate-reset-token`, `/reset-password`, `/otp/request`, `/otp/verify`) and guard is outermost before `LocalAuthGuard` — no change except JSDoc update if reordered
- [ ] T014 [US1] Add regression assertion that `LIMITS` for auth routes equals `005-auth-upgrades` defaults (5/3, 10, 5/phone+10/IP, 20, 10) in `src/modules/auth/guards/rate-limit.guard.spec.ts` snapshot or explicit equality check
- [ ] T015 [US1] Run `npm run test -- --runInBand` and `npm run build` for auth guard regression — fix any header `Retry-After` mismatch (must be `3600`)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently — auth bursts throttled, headers correct, no `AuthService` call on 429, non-regression proven

---

## Phase 4: User Story 2 — Checkout and order completion throttled per user (Priority: P1)

**Goal**: `POST /order/checkout` (alias `POST /order`) and `POST/PATCH /order/:id/complete` throttled per `req.user.sub` else IP `10/h` before any `DataSource.transaction` or inventory lock (SC-003/SC-007)

**Independent Test**: As `userA` (JWT `sub`), `POST /order/checkout` 10× within hour → 10× 201 (or 400 empty but counted) with `X-RateLimit-Limit:10`, 11th → 429 `Limit:10` with `dataSource.transaction` 0 calls; `userB` same IP 1× → 201. `POST /order/:id/complete` 10/h per user → 11th 429 with 0 `transaction` calls.

### Tests for User Story 2 ⚠️

- [ ] T016 [P] [US2] Unit test `POST /order/checkout` per-user 10→429 isolation in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `req.user.sub` uuid, `req.headers x-forwarded-for`, `req.route.path /order/checkout`, verify key `rl:POST /order/checkout:user:<sub>`, 11th 429, different `sub` still true)
- [ ] T017 [P] [US2] Unit test `POST /order/:id/complete` per-user 10→429 in `src/modules/auth/guards/rate-limit.guard.spec.ts` (route `POST /order/:id/complete` + alias `PATCH`, same per-user key, 11th 429, spy `dataSource.transaction` not called)
- [ ] T018 [P] [US2] Integration test real Redis `FLUSHDB` per-user isolation in `src/modules/order/test/rate-limit.integration.spec.ts` (new file, Test.createTestingModule with `AuthModule` guard + `OrderModule`, two users same IP, A 10→429, B 1→true)
- [ ] T019 [US2] E2E `supertest` checkout burst `x11` in `test/order-rate-limit.e2e-spec.ts` (new, `POST /auth/login` get token, `POST /order/checkout` 11×, 11th 429 body `{statusCode:429}`, verify `Order` table count still 10)

### Implementation for User Story 2

- [ ] T020 [US2] Wire `@UseGuards(RateLimitGuard)` outermost on `POST /order/checkout` and alias `POST /order` in `src/modules/order/order.controller.ts` (before `@Auth()`/`JwtGuard`, add `ApiResponse 429`, keep JSDoc)
- [ ] T021 [US2] Wire `@UseGuards(RateLimitGuard)` outermost on `POST /order/:id/complete` and `PATCH /order/:id/complete` in `src/modules/order/order.controller.ts` (per-user bucket, before `@Auth()`)
- [ ] T022 [US2] Import `AuthModule` (or `RateLimitGuard` provider) in `src/modules/order/order.module.ts` (`imports: [AuthModule, TypeOrmModule.forFeature([Order, OrderItem]), ...]`) so guard DI resolves `CACHE_MANAGER`/`ConfigService`
- [ ] T023 [US2] Add IP fallback path `req.user?.sub ?? extractIp(req)` in guard for checkout when JWT missing (verify `401` still from `Auth` after `429` check) in `src/modules/auth/guards/rate-limit.guard.ts`

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently — checkout/complete throttled per-user before DB, second user isolated, inventory lock never held under 429

---

## Phase 5: User Story 3 — High-frequency cart and admin product mutations throttled with shared Redis, reads survive outage (Priority: P2)

**Goal**: `POST /cart` + `PATCH /cart/increase|decrease` + `DELETE /cart*` shared `60/h per user`, GraphQL `createProduct/updateProduct/etc` + `inventory/:productId/increase|decrease` `30/h per admin` with distributed shared `CACHE_MANAGER` store, and any Redis-down still `200/201` via fail-open (SC-004/SC-005/SC-006)

**Independent Test**: `user X` 60× `POST /cart` → 60× true, 61st 429 `Limit:60` no cart row, `GET /cart` still 200. Admin 30× `updateProduct` → 30× true, 31st 429 per `rl:products:mutation:user:<admin>`. With `CACHE_MANAGER.get/set` throwing `ECONNREFUSED`, every throttled route still 200/201 + `Logger.warn RateLimit Redis fail-open`. Two guards sharing same store: A 5 + B 55 `POST /cart` same user → B 61st 429 shared.

### Tests for User Story 3 ⚠️

- [ ] T024 [P] [US3] Unit test `POST /cart` 60→429 shared bucket with `PATCH/DELETE` in `src/modules/auth/guards/rate-limit.guard.spec.ts` (same user sub, `POST /cart` + `PATCH /cart/increase` + `DELETE /cart` share `CART_RL_MAX=60`, 61st 429 `Limit:60`)
- [ ] T025 [P] [US3] Unit test product mutations `products:mutation` 30→429 per-admin in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `GqlExecutionContext` + `req.user.sub` admin uuid, guard extracts via `getContext().req`, 30× true, 31st 429 `Limit:30`, different admin still true)
- [ ] T026 [P] [US3] Unit test fail-open `CACHE_MANAGER.get/set` throwing `ECONNREFUSED` in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `cache.get` reject, `cache.set` reject, route `POST /cart` and `products:mutation`, expect true + `Logger.warn` spy `RateLimit Redis fail-open for <routeKey>`)
- [ ] T027 [P] [US3] Unit test success headers `X-RateLimit-Limit/Remaining` on `POST /cart` in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `count 5`, `CART_RL_MAX 60`, expect `res.setHeader('X-RateLimit-Limit','60')` and `Remaining '55'`)
- [ ] T028 [P] [US3] Integration test distributed two-instance shared counter in `src/modules/auth/test/rate-limit.distributed.integration.spec.ts` (new file, two `Test.createTestingModule` with same shared Map provider, A 5 + B 55 `POST /cart` same user, B 61st 429)
- [ ] T029 [P] [US3] Integration test Redis-down fail-open real guard in `src/modules/cart/test/rate-limit.integration.spec.ts` (new, spy `cache.get` reject, `POST /cart` still `true`)

### Implementation for User Story 3

- [ ] T030 [US3] Wire `@UseGuards(RateLimitGuard)` outermost on `POST /cart`, `PATCH /cart/increase`, `PATCH /cart/decrease`, `DELETE /cart/:cartItemId`, `DELETE /cart` in `src/modules/cart/cart.controller.ts` (per-user `60/h` shared, before `@Auth(User)`, add `ApiResponse 429`)
- [ ] T031 [US3] Import `AuthModule` in `src/modules/cart/cart.module.ts` to provide `RateLimitGuard` DI
- [ ] T032 [US3] Wire `@UseGuards(RateLimitGuard)` on GraphQL mutations `createProduct`, `createManyProducts`, `updateProduct`, `updateMany`, `removeProduct`, `removeAllProducts` in `src/modules/products/products.resolver.ts` (per-method or resolver-level, handle `GqlExecutionContext.create(ctx).getContext().req` fallback to `switchToHttp`, map to `products:mutation` bucket, before any `@Auth` if added)
- [ ] T033 [US3] (Optional) Wire `@UseGuards(RateLimitGuard)` on `POST /inventory/:productId/increase|decrease` in `src/modules/inventory/inventory.controller.ts` (same `products:mutation` bucket `30/h` per admin) — if not exposed, document as TODO in `docs/architecture/rate-limiting.md`
- [ ] T034 [US3] Ensure guard imports `GqlExecutionContext` from `@nestjs/graphql` for resolver path in `src/modules/auth/guards/rate-limit.guard.ts` with fallback `context.switchToHttp().getRequest()` and inline `// GraphQL vs REST context extraction` comment

**Checkpoint**: All user stories 1–3 should now be independently functional — cart 60/h shared bucket before DB, product 30/h per-admin, fail-open allows on Redis throw, distributed counts shared

---

## Phase 6: User Story 4 — Operators can verify rate-limit behavior and inventory lock safety (Priority: P2)

**Goal**: Headers `X-RateLimit-*` + `Retry-After:3600` on every throttled response, Swagger `429` docs, and spy proof `429` never held `FOR UPDATE` (SC-007/SC-008)

**Independent Test**: Spy `DataSource.transaction` + `InventoryService.getInventory` during `POST /order/checkout` 11th 429 → 0 calls. Assert `AllExceptionsFilter` serializes 429 with `{statusCode, message, timestamp}` plus headers. Swagger `/api` lists `429` on each protected route.

### Tests for User Story 4 ⚠️

- [ ] T035 [P] [US4] Unit test inventory lock never held on 429 in `src/modules/order/order.controller.spec.ts` (mock `RateLimitGuard` throws 429 via `cache.get` populated, spy `orderCheckoutService.checkout` 0 calls, `dataSource.transaction` 0 calls)
- [ ] T036 [P] [US4] Unit test headers on success vs 429 in `src/modules/auth/guards/rate-limit.guard.spec.ts` (success case asserts `res.setHeader('X-RateLimit-Limit','10')`+`Remaining`, 429 case asserts `ex.options.headers['Retry-After']='3600'` and `X-RateLimit-Remaining:'0'`)
- [ ] T037 [P] [US4] E2E `supertest` headers propagation in `test/rate-limit-headers.e2e-spec.ts` (new, `POST /auth/login` 1× → `x-ratelimit-limit 10` present, 11× → `retry-after 3600` present, check `AllExceptionsFilter` body shape)

### Implementation for User Story 4

- [ ] T038 [US4] Add `@ApiResponse({ status: 429, description: 'Too Many Requests — Retry-After: 3600' })` to every throttled handler in `src/modules/auth/auth.controller.ts`, `src/modules/order/order.controller.ts`, `src/modules/cart/cart.controller.ts`, `src/modules/products/products.resolver.ts`
- [ ] T039 [US4] Add `Logger.log RateLimit guards: auth 5-20/h, checkout 10/h/user, cart 60/h/user, product 30/h/admin (REDIS_URL <set|unset>, distributed|in-memory)` on first activation or `onModuleInit` in `src/modules/auth/guards/rate-limit.guard.ts`
- [ ] T040 [US4] Document protected routes map + limits table + `rl:` key pattern + shared vs in-memory + fail-open + inventory never inside guard in `docs/architecture/rate-limiting.md` (new file) or extend `docs/architecture/modules.md` with same content per plan

**Checkpoint**: At this point, User Stories 1–4 should all be independently functional — all 8 SCs observable: auth isolation, forgot two-bucket, checkout per-user before transaction, cart 60/h no read throttle, fail-open warn, distributed shared, 0 lock under 429, headers+Swagger

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Env, docs, and verification that cross multiple stories

- [ ] T041 Update `.env.example` with `ORDER_CHECKOUT_RL_MAX=10`, `ORDER_CHECKOUT_RL_WINDOW_MS=3600000`, `ORDER_COMPLETE_RL_MAX=10`, `ORDER_COMPLETE_RL_WINDOW_MS=3600000`, `CART_RL_MAX=60`, `CART_RL_WINDOW_MS=3600000`, `PRODUCT_MUTATION_RL_MAX=30`, `PRODUCT_MUTATION_RL_WINDOW_MS=3600000` in project root `.env.example`
- [ ] T042 [P] Update `docs/plan.md` Phase 10 section to mark Exit Criteria met (list protected endpoints + limits + distributed + Redis shared + fail-open) and reference `specs/010-rate-limiting/spec.md` — keep `synchronize:false` note
- [ ] T043 [P] Run `npm run lint` and fix any guard JSDoc or `no-console` violations in `src/modules/auth/guards/rate-limit.guard.ts` and wired controllers
- [ ] T044 Run `npm run build` and `npm run test -- --runInBand` (≥20 suites + 8+ new) — all PASS, no regression on `005-auth-upgrades` limits (`forgot 5/3`, `reset 10`, `login 10`) byte-equal per SC-008
- [ ] T045 Run quickstart validation from `specs/010-rate-limiting/quickstart.md` (manual bursts `POST /auth/login x11`, `POST /order/checkout x11` per-user, `POST /cart x61`, `FLUSHDB` distributed, Redis-down `docker-compose stop redis` → still 200)
- [ ] T046 [P] Clean up `Logger.warn` messages to match exact strings expected in tests (`RateLimit Redis fail-open for ${routeKey}:` and `Redis URL not set, using in-memory rate limit (non-distributed)`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3) — P1 stories (US1, US2) first for MVP
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories, guards existing auth routes
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - Depends on guard core but independent from US1 at runtime; shares same `RateLimitGuard` instance
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - May reuse US2 per-user key logic but should be independently testable (cart 60/h vs checkout 10/h different limits/keys)
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) - Documents cross-story headers/locks; ideally after US1–US3 wiring to validate Swagger headers but can be developed in parallel via mocked guard

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- Models before services (N/A — RateLimitBucket is ephemeral Redis, no model)
- Guard helpers before controller wiring
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (T002, T003)
- All Foundational tasks marked [P] can run in parallel (T005, T006) — after T004 base extension
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel (T010–T012, T016–T018, T024–T029, T035–T037)
- Different user stories can be worked on in parallel by different team members (US1 vs US2 vs US3)

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (if tests requested):
Task: "Unit test auth POST /auth/login 10→429 IP isolated in src/modules/auth/guards/rate-limit.guard.spec.ts"
Task: "Unit test POST /auth/forgot-password per-email 3 + per-IP 5 two-bucket in src/modules/auth/guards/rate-limit.guard.spec.ts"
Task: "Integration test real Redis FLUSHDB auth 10→429 isolation in src/modules/auth/test/rate-limit.integration.spec.ts"

# After tests fail as expected, implement guard helpers and verify wiring:
Task: "Verify existing @UseGuards(RateLimitGuard) on POST /auth/* routes in src/modules/auth/auth.controller.ts"
```

---

## Parallel Example: User Story 2

```bash
# Launch all tests for checkout/complete together:
Task: "Unit test POST /order/checkout per-user 10→429 isolation in src/modules/auth/guards/rate-limit.guard.spec.ts"
Task: "Unit test POST /order/:id/complete per-user 10→429 in src/modules/auth/guards/rate-limit.guard.spec.ts"
Task: "Integration test real Redis FLUSHDB per-user isolation in src/modules/order/test/rate-limit.integration.spec.ts"

# Wire controllers in parallel once guard ready:
Task: "Wire @UseGuards(RateLimitGuard) outermost on POST /order/checkout in src/modules/order/order.controller.ts"
Task: "Wire @UseGuards(RateLimitGuard) outermost on POST /order/:id/complete in src/modules/order/order.controller.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories) — guard core with ConfigService + helpers + export
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently — auth 10→429 same IP, different IP true, forgot 3/email 5/IP still pass, headers correct, no regression
5. Deploy/demo if ready — MVP proves rate limiting not broken by generalization

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (guard injects `CACHE_MANAGER`+`ConfigService`, builds `rl:` keys)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently (checkout/complete per-user before transaction) → Deploy/Demo
4. Add User Story 3 → Test independently (cart 60/h + product 30/h + distributed + fail-open) → Deploy/Demo
5. Add User Story 4 → Test independently (headers + Swagger + 0 lock spy) → Deploy/Demo
6. Each story adds value without breaking previous stories (auth limits stay byte-equal)

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (guard core extension T004–T009)
2. Once Foundational is done:
   - Developer A: User Story 1 (auth regression)
   - Developer B: User Story 2 (checkout/complete per-user)
   - Developer C: User Story 3 (cart + product + distributed + fail-open)
   - Developer D: User Story 4 (observability + docs + 0 lock)
3. Stories complete and integrate independently via shared `RateLimitGuard` provider

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable — verify `npm run test -- --runInBand --testNamePattern="US1|US2"` per story
- Verify tests fail before implementing — run mocked `CACHE_MANAGER` 11th call should be 429 before wiring
- Commit after each task or logical group (`git add -A && git commit -m "feat(rate-limit): ..."` per plan)
- Stop at any checkpoint to validate story independently via `npm run build && npm run test -- --runInBand`
- Avoid: vague tasks, same file conflicts (guard spec vs guard impl concurrent edits — use `git merge` carefully), cross-story dependencies that break independence (cart 60/h must not require checkout 10/h)
