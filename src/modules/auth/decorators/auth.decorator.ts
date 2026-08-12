import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { UserRoles } from 'src/modules/users/enum/roles';
import { JwtGuard } from '../guards/jwt.guard';
import { RolesGuard } from '../guards/roles.guard';

export const ROLESKEY = 'roles';
export function Auth(...roles: UserRoles[]) {
  return applyDecorators(
    SetMetadata(ROLESKEY, roles),
    UseGuards(JwtGuard, RolesGuard),
  );
}
