import { ExecutionContext, Injectable, ValidationPipe } from '@nestjs/common';
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
