import { HttpStatus } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { RateLimitGuard } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let cacheMock: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let loggerWarnSpy: jest.SpyInstance;

  const createContext = (overrides: {
    method?: string;
    routePath?: string;
    path?: string;
    ip?: string;
    headers?: Record<string, string>;
    body?: any;
    res?: any;
  } = {}) => {
    const {
      method = 'POST',
      routePath = '/auth/forgot-password',
      path = '/auth/forgot-password',
      ip = '1.2.3.4',
      headers = {},
      body = {},
      res,
    } = overrides;
    const mockRes = res || { setHeader: jest.fn() };
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
        getResponse: () => mockRes,
      }),
    };
    return { ctx, req, res: mockRes };
  };

  beforeEach(async () => {
    cacheMock = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: CACHE_MANAGER, useValue: cacheMock },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
    // spy on internal logger.warn
    loggerWarnSpy = jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should allow request when no limit config matches', async () => {
    const { ctx } = createContext({
      method: 'GET',
      routePath: '/health',
      path: '/health',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(cacheMock.get).not.toHaveBeenCalled();
  });

  describe('forgot-password 5/h IP', () => {
    it('should allow up to 5 and set success headers', async () => {
      cacheMock.get.mockResolvedValue(0); // count will be 1
      const { ctx, res } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: {},
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(cacheMock.set).toHaveBeenCalledWith(expect.stringContaining('ip'), 1, 3600_000);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    });

    it('should throw 429 with Retry-After and X-RateLimit headers when IP limit exceeded (6th)', async () => {
      // simulate 5 already stored, next becomes 6 >5
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':ip:')) return 5;
        return undefined;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: {},
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.getStatus()).toBe(429);
        // B1 full headers: Retry-After + X-RateLimit-*
        const headers = e.options?.headers || {};
        expect(headers['Retry-After']).toBe('3600');
        expect(headers['X-RateLimit-Limit']).toBe('5');
        expect(headers['X-RateLimit-Remaining']).toBe('0');
      }
    });

    it('should increment via get/set (INCR+EXPIRE semantics)', async () => {
      cacheMock.get.mockResolvedValue(2);
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: {},
      });
      await guard.canActivate(ctx);
      expect(cacheMock.get).toHaveBeenCalledWith(expect.stringContaining('rl:POST /auth/forgot-password:ip:'));
      expect(cacheMock.set).toHaveBeenCalledWith(expect.stringContaining('rl:POST /auth/forgot-password:ip:'), 3, 3600_000);
    });
  });

  describe('forgot-password extra email limit 3/h vs 5/h IP', () => {
    it('should enforce email limit 3/h (extra key)', async () => {
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':email:')) return 3; // already 3, next 4 >3
        if (key.includes(':ip:')) return 0;
        return undefined;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: { email: 'alice@example.com' },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: 429,
      });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.options.headers['X-RateLimit-Limit']).toBe('3');
        expect(e.options.headers['Retry-After']).toBe('3600');
      }
      expect(cacheMock.get).toHaveBeenCalledWith(expect.stringContaining(':email:alice@example.com'));
    });

    it('should allow when email under limit but IP at limit -> IP throws 429 with limit 5', async () => {
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':email:')) return 1; // 2 <=3
        if (key.includes(':ip:')) return 5; // 6 >5
        return undefined;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: { email: 'bob@example.com' },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.options.headers['X-RateLimit-Limit']).toBe('5');
      }
    });

    it('should use 3 limit for email and 5 for IP (different thresholds)', async () => {
      // email threshold 3, IP threshold 5
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':email:')) return 2; // will become 3 -> OK
        if (key.includes(':ip:')) return 4; // will become 5 -> OK
        return undefined;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: { email: 'c@example.com' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('10/h IP limits', () => {
    const routes10 = [
      'POST /auth/reset-password',
      'POST /auth/validate-reset-token',
      'POST /auth/login',
      'POST /auth/register',
    ];
    for (const route of routes10) {
      const [method, path] = route.split(' ');
      it(`should allow 10 and block 11th for ${route}`, async () => {
        // 10th request: get returns 9 -> count 10 OK
        cacheMock.get.mockResolvedValue(9);
        const { ctx } = createContext({ method, routePath: path, path, body: {} });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);

        // 11th: get 10 -> count 11 >10 -> 429
        cacheMock.get.mockResolvedValue(10);
        const { ctx: ctx2 } = createContext({ method, routePath: path, path, body: {} });
        await expect(guard.canActivate(ctx2)).rejects.toMatchObject({ status: 429 });
        try {
          await guard.canActivate(ctx2);
        } catch (e: any) {
          expect(e.options.headers['Retry-After']).toBe('3600');
          expect(e.options.headers['X-RateLimit-Limit']).toBe('10');
          expect(e.options.headers['X-RateLimit-Remaining']).toBe('0');
          expect(e.getStatus()).toBe(429);
        }
      });
    }
  });

  describe('google 20/h IP', () => {
    it('should allow 20 and block 21st', async () => {
      cacheMock.get.mockResolvedValue(19);
      const { ctx } = createContext({
        method: 'GET',
        routePath: '/auth/google/callback',
        path: '/auth/google/callback',
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(cacheMock.set).toHaveBeenCalledWith(expect.stringContaining('rl:GET /auth/google/callback:ip:'), 20, 3600_000);

      cacheMock.get.mockResolvedValue(20);
      const { ctx: ctx2 } = createContext({
        method: 'GET',
        routePath: '/auth/google/callback',
        path: '/auth/google/callback',
      });
      await expect(guard.canActivate(ctx2)).rejects.toMatchObject({ status: 429 });
      try {
        await guard.canActivate(ctx2);
      } catch (e: any) {
        expect(e.options.headers['X-RateLimit-Limit']).toBe('20');
        expect(e.options.headers['Retry-After']).toBe('3600');
      }
    });
  });

  describe('otp/request dual limits', () => {
    it('should enforce phone limit 5/h (extra key)', async () => {
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':phone:')) return 5; // 6 >5
        return 0;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/otp/request',
        path: '/auth/otp/request',
        body: { phoneNumber: '+201012345678' },
      });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      try {
        await guard.canActivate(ctx);
      } catch (e: any) {
        expect(e.options.headers['X-RateLimit-Limit']).toBe('5');
      }
    });

    it('should allow when phone under limit but still check IP', async () => {
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':phone:')) return 0;
        if (key.includes(':ip:')) return 4; // 5 <=5 OK (current impl max 5 for otp/request)
        return 0;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/otp/request',
        path: '/auth/otp/request',
        body: { phoneNumber: '+201012345678' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('otp/verify 10/h', () => {
    it('should allow 10 and block 11th', async () => {
      cacheMock.get.mockResolvedValue(9);
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/otp/verify',
        path: '/auth/otp/verify',
        body: { phoneNumber: '+201012345678', otp: '123456' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      cacheMock.get.mockResolvedValue(10);
      const { ctx: ctx2 } = createContext({
        method: 'POST',
        routePath: '/auth/otp/verify',
        path: '/auth/otp/verify',
        body: { phoneNumber: '+201012345678', otp: '123456' },
      });
      await expect(guard.canActivate(ctx2)).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('fail-open on Redis down', () => {
    it('should warn and allow request when cache.get throws', async () => {
      cacheMock.get.mockRejectedValue(new Error('Redis down'));
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: { email: 'a@b.com' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('RateLimit Redis fail-open'));
      // metric auth_rate_limit_fallback_total would increment here (comment in guard)
    });

    it('should warn and allow when cache.set throws after get', async () => {
      cacheMock.get.mockResolvedValue(0);
      cacheMock.set.mockRejectedValue(new Error('Redis SET failed'));
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/login',
        path: '/auth/login',
        body: { email: 'a@b.com', password: 'x' },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('should not suppress 429 (TooMany) in fail-open catch', async () => {
      cacheMock.get.mockImplementation(async (key: string) => {
        if (key.includes(':ip:')) return 5;
        return 0;
      });
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/forgot-password',
        path: '/auth/forgot-password',
        body: {},
      });
      // should still throw 429, not fail-open to true
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should handle x-forwarded-for IP extraction', async () => {
      cacheMock.get.mockResolvedValue(0);
      const { ctx } = createContext({
        method: 'POST',
        routePath: '/auth/login',
        path: '/auth/login',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        ip: '1.1.1.1',
      });
      await guard.canActivate(ctx);
      expect(cacheMock.get).toHaveBeenCalledWith(expect.stringContaining('9.9.9.9'));
    });
  });

  describe('rate limit headers', () => {
    it('should set X-RateLimit-Limit/Remaining on success and Retry-After on 429', async () => {
      cacheMock.get.mockResolvedValue(1); // count 2
      const { ctx, res } = createContext({
        method: 'POST',
        routePath: '/auth/login',
        path: '/auth/login',
      });
      await guard.canActivate(ctx);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '8');

      // 429 path
      cacheMock.get.mockResolvedValue(10);
      const { ctx: ctx2 } = createContext({
        method: 'POST',
        routePath: '/auth/login',
        path: '/auth/login',
      });
      try {
        await guard.canActivate(ctx2);
        fail('should throw');
      } catch (e: any) {
        expect(e.options.headers['Retry-After']).toBeDefined();
        expect(e.options.headers['X-RateLimit-Limit']).toBe('10');
        expect(e.options.headers['X-RateLimit-Remaining']).toBe('0');
        // ensure fail-open metric comment would be hit on Redis down, not here
      }
    });
  });
});
