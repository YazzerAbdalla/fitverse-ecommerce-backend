import { ExecutionContext, Injectable, ValidationPipe } from '@nestjs/common';
/**
 * This guard is responsible for passport-local credential validation.
 * It keeps its explicit LoginDto pre-validation (T031 proof-gate, 2026-10-03):
 * the login handler reads `@Request()`, not `@Body() LoginDto`, so the
 * global ValidationPipe never sees the payload — without this block,
 * malformed logins would 401 (bad credentials) instead of 400 (bad input).
 * Removing it changes the wire contract; revisit only with an amendment.
 *
 * Used by: AuthController login route.
 */
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { LoginDto } from '../dto/login.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
  constructor() {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();

    const dto = plainToInstance(LoginDto, request.body);

    const errors = await validate(dto);

    if (errors.length) {
      throw new BadRequestException(errors);
    }

    return (await super.canActivate(context)) as boolean;
  }
}
