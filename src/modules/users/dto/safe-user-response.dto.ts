import { ApiProperty } from '@nestjs/swagger';
import User, { AuthProvider } from '../entity/user.entity';
import { UserRoles } from '../enum/roles';

/**
 * Client-safe user projection (allow-list).
 * It exposes identity, role, provider, verification flags and notification
 * preferences — and nothing else.
 *
 * Responsibility (SRP): define the exact user shape clients may see, nothing else.
 * Used by: UsersController.getMe, AuthService.register (via toSafeUser).
 * Depends on: User entity (read-only input), UserRoles/AuthProvider (types).
 */
export class SafeUserResponseDto {
  @ApiProperty({ description: 'User UUID', example: '3f...c9' })
  id!: string;

  @ApiProperty({ description: 'First name', example: 'Alaa' })
  firstName!: string;

  @ApiProperty({ description: 'Last name', example: 'Test' })
  lastName!: string;

  @ApiProperty({ description: 'Email address', example: 'alaa@test.com' })
  email!: string;

  @ApiProperty({
    description: 'Role',
    enum: UserRoles,
    enumName: 'UserRoles',
    example: UserRoles.User,
  })
  role!: UserRoles;

  @ApiProperty({
    description: 'Auth provider',
    enum: AuthProvider,
    enumName: 'AuthProvider',
    example: AuthProvider.Local,
  })
  provider!: AuthProvider;

  @ApiProperty({
    description: 'E.164 phone number, if set',
    example: '+201000000001',
    required: false,
    nullable: true,
  })
  phoneNumber!: string | null;

  @ApiProperty({ description: 'Phone verified flag', example: false })
  phoneVerified!: boolean;

  @ApiProperty({ description: 'Email verified flag', example: false })
  emailVerified!: boolean;

  @ApiProperty({ description: 'Marketing opt-in flag', example: false })
  marketingOptIn!: boolean;

  @ApiProperty({ description: 'Email channel opt-in flag', example: true })
  emailOptIn!: boolean;
}

/**
 * Projects a User row onto the client-safe allow-list.
 * New sensitive columns (password hash, token hashes, expiries) are excluded
 * by construction: only listed fields are copied, never rest-spread.
 *
 * @param user - Full User row (server-side only, never returned directly).
 * @returns The client-safe projection.
 */
export function toSafeUser(user: User): SafeUserResponseDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    provider: user.provider,
    phoneNumber: user.phoneNumber ?? null,
    phoneVerified: user.phoneVerified,
    emailVerified: user.emailVerified,
    marketingOptIn: user.marketingOptIn,
    emailOptIn: user.emailOptIn,
  };
}
