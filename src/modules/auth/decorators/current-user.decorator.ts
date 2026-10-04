import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { JwtPayload } from '../types';

/**
 * Reads the authenticated payload attached by JwtGuard (HTTP only).
 * `@CurrentUser()` returns the whole payload, `@CurrentUser('sub')` one prop.
 */
export const CurrentUser = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();
    const user = request.user;

    // If a specific property key is passed (e.g., @User('email')), return only that property
    return data ? (user?.[data] as string) : user;
  },
);
