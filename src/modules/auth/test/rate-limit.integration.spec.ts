import { INestApplication, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { RateLimitGuard } from '../guards/rate-limit.guard';
import type { Cache } from 'cache-manager';
import { ConfigModule } from '@nestjs/config';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

describe('RateLimit Integration (real Redis)', () => {
  let guard: RateLimitGuard;
  let cache: Cache;
  let redisAvailable = false;
  let moduleRef: TestingModule;

  const createContext = (overrides: {
    method?: string;
    routePath?: string;
    path?: string;
    ip?: string;
    headers?: Record<string, string>;
    body?: any;
  }) => {
    const {
      method = 'POST',
      routePath = '/auth/forgot-password',
      path = '/auth/forgot-password',
      ip = `10.0.0.1`,
      headers = {},
      body = {},
    } = overrides;
    const res: any = { setHeader: jest.fn(), statusCode: 200, headers: {} };
    res.setHeader = jest.fn((k: string, v: string) => {
      res.headers[k] = v;
    });
    const req: any = {
      method,
      route: routePath ? { path: routePath } : undefined,
      path,
      ip,
      headers,
      body,
    };
    const ctx: any = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    };
    return { ctx, req, res };
  };

  const uniqueIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

  beforeAll(async () => {
    try {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          CacheModule.registerAsync({
            useFactory: () => ({
              stores: [createKeyv(REDIS_URL)],
              ttl: 60 * 1000,
            }),
            isGlobal: false,
          }),
        ],
        providers: [RateLimitGuard],
      }).compile();

      cache = moduleRef.get<Cache>(CACHE_MANAGER);
      guard = moduleRef.get<RateLimitGuard>(RateLimitGuard);

      // ping redis
      await cache.set('__rl_integration_ping', 1, 2000);
      const v = await cache.get<number>('__rl_integration_ping');
      if (v === 1) {
        redisAvailable = true;
        await cache.del('__rl_integration_ping');
        // eslint-disable-next-line no-console
        console.log('[rate-limit integration] Redis available at', REDIS_URL);
      } else {
        throw new Error('ping mismatch');
      }
    } catch (e) {
      redisAvailable = false;
      // eslint-disable-next-line no-console
      console.warn('[rate-limit integration] Redis not available, integration tests will be skipped gracefully. Set REDIS_URL or start docker redis. Error:', (e as Error).message);
      // fallback to mock cache so fail-open test still runs
      if (!guard) {
        const mockCache: any = {
          get: jest.fn().mockResolvedValue(undefined),
          set: jest.fn().mockResolvedValue(undefined),
          del: jest.fn().mockResolvedValue(undefined),
        };
        const fallbackMod = await Test.createTestingModule({
          providers: [RateLimitGuard, { provide: CACHE_MANAGER, useValue: mockCache }],
        }).compile();
        guard = fallbackMod.get<RateLimitGuard>(RateLimitGuard);
        cache = mockCache as unknown as Cache;
      }
    }
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close().catch(() => {});
    if (redisAvailable && cache) {
      // best-effort cleanup of test keys (prefix rl:)
      try {
        // keyv/redis store may expose clear; try del pattern via scan if available
        const anyCache: any = cache;
        if (anyCache.store?.clear) await anyCache.store.clear().catch(() => {});
        if (anyCache.clear) await anyCache.clear().catch(() => {});
      } catch {}
    }
  });

  it('should note skip gracefully when Redis unavailable', () => {
    if (!redisAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[rate-limit integration] SKIP: Redis not available — tests gracefully skipped (mock fail-open will still be verified)');
    }
    expect(guard).toBeDefined();
  });

  describe('exceed forgot-password 5/h IP -> 6th 429', () => {
    it('6th request returns 429 with Retry-After + X-RateLimit headers', async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn('SKIP real redis: forgot-password 6th 429 — redis unavailable');
        return;
      }
      const ip = uniqueIp();
      // 5 allowed
      for (let i = 0; i < 5; i++) {
        const { ctx, res } = createContext({
          method: 'POST',
          routePath: '/auth/forgot-password',
          path: '/auth/forgot-password',
          ip,
          body: {},
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
      }
      // 6th -> 429
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        ip,
        body: {},
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.getStatus()).toBe(429);
        expect(e.options.headers['Retry-After']).toBe('3600');
        expect(e.options.headers['X-RateLimit-Limit']).toBe('5');
        expect(e.options.headers['X-RateLimit-Remaining']).toBe('0');
      }
      // cleanup
      await cache.del(`rl:POST /auth/forgot-password:ip:${ip}`).catch(() => {});
    });
  });

  describe('otp/request 429 and otp/verify 429', () => {
    it('otp/request phone 5/h -> 6th 429', async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn('SKIP real redis: otp/request');
        return;
      }
      const ip = uniqueIp();
      const phone = `+2010${Math.floor(1000000 + Math.random() * 9000000)}`;
      for (let i = 0; i < 5; i++) {
        const { ctx } = createContext({
          method: 'POST',
          routePath: '/auth/otp/request',
          path: '/auth/otp/request',
          ip,
          body: { phoneNumber: phone },
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/otp/request',
        path: '/auth/otp/request',
        ip,
        body: { phoneNumber: phone },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      await cache.del(`rl:POST /auth/otp/request:phone:${phone}`).catch(() => {});
      await cache.del(`rl:POST /auth/otp/request:ip:${ip}`).catch(() => {});
    });

    it('otp/verify 10/h -> 11th 429', async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn('SKIP real redis: otp/verify');
        return;
      }
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) {
        const { ctx } = createContext({
          method: 'POST',
          routePath: '/auth/otp/verify',
          path: '/auth/otp/verify',
          ip,
          body: { phoneNumber: '+201012345678', otp: '123456' },
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/otp/verify',
        path: '/auth/otp/verify',
        ip,
        body: { phoneNumber: '+201012345678', otp: '123456' },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      await cache.del(`rl:POST /auth/otp/verify:ip:${ip}`).catch(() => {});
    });
  });

  describe('google/callback 20/h IP -> 21st 429', () => {
    it('21st returns 429', async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn('SKIP real redis: google/callback');
        return;
      }
      const ip = uniqueIp();
      for (let i = 0; i < 20; i++) {
        const { ctx } = createContext({
          method: 'GET',
          routePath: '/auth/google/callback',
          path: '/auth/google/callback',
          ip,
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
      const { ctx } = createContext({
        method: 'GET',
        routePath: '/auth/google/callback',
        path: '/auth/google/callback',
        ip,
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.options.headers['X-RateLimit-Limit']).toBe('20');
        expect(e.options.headers['Retry-After']).toBe('3600');
      }
      await cache.del(`rl:GET /auth/google/callback:ip:${ip}`).catch(() => {});
    });
  });

  describe('login/register 10/h IP -> 11th 429', () => {
    it('login 11th returns 429', async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn('SKIP real redis: login');
        return;
      }
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) {
        const { ctx } = createContext({
          method: 'POST',
          routePath: '/auth/login',
          path: '/auth/login',
          ip,
          body: { email: 'a@b.com', password: 'x' },
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/login',
        path: '/auth/login',
        ip,
        body: { email: 'a@b.com', password: 'x' },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      await cache.del(`rl:POST /auth/login:ip:${ip}`).catch(() => {});
    });
  });

  describe('Redis down fail-open → 200 + warn', () => {
    it('allows request and logs warn when cache throws (fail-open, metric auth_rate_limit_fallback_total)', async () => {
      // use a fresh guard with a failing cache mock to simulate Redis down
      const failingCache: any = {
        get: jest.fn().mockRejectedValue(new Error('Redis down simulated')),
        set: jest.fn().mockRejectedValue(new Error('Redis down')),
        del: jest.fn(),
      };
      const mod = await Test.createTestingModule({
        providers: [RateLimitGuard, { provide: CACHE_MANAGER, useValue: failingCache }],
      }).compile();
      const failingGuard = mod.get<RateLimitGuard>(RateLimitGuard);
      const warnSpy = jest.spyOn((failingGuard as any).logger, 'warn').mockImplementation(() => {});

      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        ip: '9.9.9.9',
        body: { email: 'down@example.com' },
      });
      await expect(failingGuard.canActivate(ctx)).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RateLimit Redis fail-open'));
      // metric auth_rate_limit_fallback_total would increment here (guard comment)
      await mod.close();
    });

    it('real guard also fail-opens when underlying redis store throws (if real redis available, simulate via spied get)', async () => {
      if (!redisAvailable) {
        // still verify with mock — already covered above, so pass
        expect(true).toBe(true);
        return;
      }
      const spy = jest.spyOn(cache as any, 'get').mockRejectedValueOnce(new Error('Redis down'));
      const warnSpy = jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => {});
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/reset-password',
        path: '/auth/reset-password',
        ip: uniqueIp(),
        body: { email: 'a@b.com', token: 'x', newPassword: 'y' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      spy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
