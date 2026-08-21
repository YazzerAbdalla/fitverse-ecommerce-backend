# ADR 0005 — JWT Authentication (Passport + bcrypt + Roles)

- **Status:** Accepted
- **Context:** Need stateless auth for REST endpoints with role-based access.
- **Decision:** **Passport** local strategy for credential validation, **JWT**
  (`@nestjs/jwt`, global `JwtModule`) for sessions, **bcrypt** (salt rounds 10)
  for password hashing. Authorization via `UserRoles` enum (`Admin`, `User`),
  `JwtGuard` + `RolesGuard`, applied with the `@Auth(...roles)` decorator;
  current user via `@CurrentUser()`.
- **Consequences:** All auth is centrally handled — controllers should not
  hand-roll auth. Passwords are never returned (stripped in `AuthService`).
  JWT secret/expery come from `.env` (`JWT_SECRET`, `JWT_EXPIRES_IN`).
- **Source:** `src/modules/auth/*`, `src/modules/users/enum/roles.ts`,
  `docs/api/conventions.md`.
