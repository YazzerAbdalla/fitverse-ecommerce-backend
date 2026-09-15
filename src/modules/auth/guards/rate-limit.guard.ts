import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Request } from 'express';

const LIMITS: Record<
  string,
  { max: number; windowMs: number; keyFn?: (req: Request) => string }
> = {
  'POST /auth/forgot-password': { max: 5, windowMs: 3600_000 },
  'POST /auth/forgot-password:email': { max: 3, windowMs: 3600_000 },
  'POST /auth/reset-password': { max: 10, windowMs: 3600_000 },
  'POST /auth/validate-reset-token': { max: 10, windowMs: 3600_000 },
  'POST /auth/otp/request': { max: 5, windowMs: 3600_000 },
  'POST /auth/otp/request:ip': { max: 10, windowMs: 3600_000 },
  'POST /auth/otp/verify': { max: 10, windowMs: 3600_000 },
  'GET /auth/google/callback': { max: 20, windowMs: 3600_000 },
  'POST /auth/login': { max: 10, windowMs: 3600_000 },
  'POST /auth/register': { max: 10, windowMs: 3600_000 },
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  constructor(@Inject(CACHE_MANAGER) private cache: Cache) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const routeKey = `${req.method} ${req.route?.path || req.path}`;
    const cfg = LIMITS[routeKey];
    if (!cfg) return true;

    try {
      const ip =
        (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';
      const ipKey = `rl:${routeKey}:ip:${ip}`;
      const count = ((await this.cache.get<number>(ipKey)) || 0) + 1;
      await (this.cache as any).set(ipKey, count, cfg.windowMs);

      // email/phone specific limits
      let extraKey: string | null = null;
      if (routeKey === 'POST /auth/forgot-password' && req.body?.email) {
        extraKey = `rl:${routeKey}:email:${req.body.email}`;
      } else if (
        routeKey === 'POST /auth/otp/request' &&
        req.body?.phoneNumber
      ) {
        extraKey = `rl:${routeKey}:phone:${req.body.phoneNumber}`;
      }
      if (extraKey) {
        const c = ((await this.cache.get<number>(extraKey)) || 0) + 1;
        await (this.cache as any).set(extraKey, c, cfg.windowMs);
        const limit = routeKey === 'POST /auth/forgot-password' ? 3 : 5;
        if (c > limit) throw this.tooMany(extraKey, limit);
      }

      if (count > cfg.max) throw this.tooMany(ipKey, cfg.max);

      // set headers even on success
      const res = context.switchToHttp().getResponse();
      res.setHeader('X-RateLimit-Limit', String(cfg.max));
      res.setHeader(
        'X-RateLimit-Remaining',
        String(Math.max(0, cfg.max - count)),
      );
    } catch (e) {
      if (
        e instanceof HttpException &&
        e.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      )
        throw e;
      this.logger.warn(`RateLimit Redis fail-open for ${routeKey}: ${e}`);
      // fail-open metric
      // metric: auth_rate_limit_fallback_total would be incremented here
    }
    return true;
  }

  private tooMany(_key: string, limit: number): HttpException {
    const ex: any = new HttpException(
      'Too Many Requests',
      HttpStatus.TOO_MANY_REQUESTS,
    );
    ex.options = {
      headers: {
        'Retry-After': '3600',
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
      },
    };
    // Nest will set status 429; headers set via filter if needed
    return ex;
  }
}
