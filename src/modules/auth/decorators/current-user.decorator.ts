import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { JwtPayloadProps } from '../types';

export const CurrentUser = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: JwtPayloadProps }>();
    const user = request.user;

    // If a specific property key is passed (e.g., @User('email')), return only that property
    return data ? (user?.[data] as string) : user;
  },
);
