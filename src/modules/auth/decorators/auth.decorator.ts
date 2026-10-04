import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { UserRoles } from 'src/modules/users/enum/roles';
import { JwtGuard } from '../guards/jwt.guard';
import { RolesGuard } from '../guards/roles.guard';

export const ROLESKEY = 'roles';
/**
 * Protects a route with JWT authentication plus role authorization.
 * Bare `@Auth()` means authenticated-only (RolesGuard passes empty roles).
 * Applies JwtGuard first so request.user is loaded before RolesGuard reads it.
 *
 * @param roles - Allowed roles (empty = any authenticated user).
 * @returns Combined decorator.
 */
export function Auth(...roles: UserRoles[]) {
  return applyDecorators(
    SetMetadata(ROLESKEY, roles),
    UseGuards(JwtGuard, RolesGuard),
  );
}
