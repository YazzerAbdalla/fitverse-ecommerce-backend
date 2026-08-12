import { UserRoles } from '../users/enum/roles';

export interface JwtPayloadProps {
  sub?: string;
  email?: string;
  fullName: string;
  role?: UserRoles;
}
