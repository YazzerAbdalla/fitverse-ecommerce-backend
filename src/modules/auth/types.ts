import { UserRoles } from '../users/enum/roles';

/**
 * Decoded JWT payload attached to the request by JwtGuard.
 * sub/email locate the user, role gates RolesGuard, tokenVersion revokes,
 * iat/exp are standard time claims (seconds since epoch).
 *
 * Responsibility (SRP): JWT payload shape contract, nothing else.
 * Used by: JwtGuard/strategy (writers), RolesGuard, CurrentUser, controllers.
 * Depends on: UserRoles (role type).
 */
export interface JwtPayload {
  sub?: string;
  email?: string;
  fullName: string;
  role?: UserRoles;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}
