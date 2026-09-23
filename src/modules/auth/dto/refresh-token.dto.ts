import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * This DTO is responsible for refresh token input validation.
 * It handles dual transport: body refreshToken OR HttpOnly cookie fallback.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description: 'Opaque refresh token 64 hex (cookie fallback allowed)',
    example: 'a3f1c9e8b2d4f6a1c3e5d7f9a1b2c4d6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4',
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'refreshToken must be 64 hex characters',
  })
  refreshToken?: string;
}

/**
 * This DTO is responsible for logout input validation.
 * Reuses same 64 hex shape as RefreshTokenDto.
 */
export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Refresh token to revoke (cookie fallback allowed)',
    example:
      'a3f1c9e8b2d4f6a1c3e5d7f9a1b2c4d6e8f0a1b2c4d6e8f0a1b2c4d6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4',
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  refreshToken?: string;
}
