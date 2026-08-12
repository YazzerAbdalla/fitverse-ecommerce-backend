import { SetMetadata } from '@nestjs/common';

export const ROLESKEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLESKEY, roles);
