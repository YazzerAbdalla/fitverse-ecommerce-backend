import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';
import crypto from 'crypto';

const DEFAULT_LIMITS: Record<string, { max: number; windowMs: number }> = {
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
  'POST /auth/refresh': { max: 10, windowMs: 3600_000 },
  'POST /auth/refresh:hash': { max: 5, windowMs: 3600_000 },
  'POST /auth/logout': { max: 20, windowMs: 3600_000 },
  'POST /auth/logout-all': { max: 10, windowMs: 3600_000 },
  // Phase 10 — Order / Cart / Product mutations
  'POST /order/checkout': { max: 10, windowMs: 3600_000 },
  'POST /order': { max: 10, windowMs: 3600_000 },
  'POST /order/:id/complete': { max: 10, windowMs: 3600_000 },
  'PATCH /order/:id/complete': { max: 10, windowMs: 3600_000 },
  'POST /cart': { max: 60, windowMs: 3600_000 },
  'PATCH /cart/increase': { max: 60, windowMs: 3600_000 },
  'PATCH /cart/decrease': { max: 60, windowMs: 3600_000 },
  'DELETE /cart': { max: 60, windowMs: 3600_000 },
  'DELETE /cart/:cartItemId': { max: 60, windowMs: 3600_000 },
  'products:mutation': { max: 30, windowMs: 3600_000 },
  // Phase 18 — Email Service (specs/014-email-service FR-009, T017)
  'GET /auth/verify-email': { max: 10, windowMs: 3600_000 },
  'POST /auth/verify-email': { max: 10, windowMs: 3600_000 },
  'POST /auth/resend-verification': { max: 5, windowMs: 3600_000 },
  'POST /auth/resend-verification:email': { max: 3, windowMs: 3600_000 },
  'POST /admin/notifications/sales': { max: 10, windowMs: 3600_000 },
  'POST /admin/notifications/test-email': { max: 10, windowMs: 3600_000 },
  // Phase 19 — Payment simulation (018): same 10/h quota as checkout (Q3/D6)
  'POST /payments/intent': { max: 10, windowMs: 3600_000 },
  'POST /payments/:id/confirm': { max: 10, windowMs: 3600_000 },
};

/** Single fixed-window bucket resolved for a request. */
interface RateLimitBucket {
  routeKey: string;
  dim: string;
  value: string;
  max: number;
  windowMs: number;
}

/** Minimal request view used for route-key + dimension resolution. */
interface RateLimitRequest {
  method?: string;
  path?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { sub?: string };
  body?: Record<string, unknown>;
  cookies?: Record<string, string>;
}

/** Minimal response view used for rate-limit headers. */
interface RateLimitResponse {
  setHeader(name: string, value: string): void;
}

/** 429 header carrier read by AllExceptionsFilter (HttpException exposes no options member). */
interface RateLimitHeadersCarrier {
  options?: { headers?: Record<string, string> };
}

/**
 * Minimal typed surface of the cache used for fixed-window counters.
 * cache-manager's Cache type exposes no set-with-TTL generically, so the
 * single documented cast lives in `counterCache()` instead of at each call.
 */
interface RateLimitCounterCache {
  set(key: string, value: number, ttlMs: number): Promise<unknown>;
}

/**
 * This guard is responsible for distributed per-route rate limiting (Redis shared, fail-open).
 * It handles IP and per-email/phone/user buckets via the shared CACHE_MANAGER (createKeyv REDIS_URL),
 * enforces fixed-window quotas (auth 5-20/h, checkout/complete 10/h/user, cart 60/h/user, product 30/h/admin,
 * verify-email 10/h/IP, resend-verification 5/h/IP + 3/h/email, sales 10/h/user),
 * applies outermost before JwtGuard/DataSource.transaction so throttling never holds inventory FOR UPDATE,
 * and fails open on Redis errors (warn + allow).
 * Note: resend-verification 60s per-email cooldown (resend:cooldown:<email> SET NX EX 60) is enforced
 * in AuthService.resendVerification, not in this guard — the guard handles the two hourly rate buckets only.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  constructor(
    @Inject(CACHE_MANAGER) private cache: Cache,
    @Optional() private readonly configService: ConfigService,
  ) {
    const redisUrl = this.configService?.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn(
        'Redis URL not set, using in-memory rate limit (non-distributed)',
      );
    }
    const checkoutMax = this.getConfigMax(
      'ORDER_CHECKOUT_RL_MAX',
      DEFAULT_LIMITS['POST /order/checkout'].max,
    );
    const checkoutWin = this.getConfigWindow(
      'ORDER_CHECKOUT_RL_WINDOW_MS',
      DEFAULT_LIMITS['POST /order/checkout'].windowMs,
    );
    const cartMax = this.getConfigMax(
      'CART_RL_MAX',
      DEFAULT_LIMITS['POST /cart'].max,
    );
    const prodMax = this.getConfigMax(
      'PRODUCT_MUTATION_RL_MAX',
      DEFAULT_LIMITS['products:mutation'].max,
    );
    const refreshMax = this.getConfigMax(
      'REFRESH_RL_MAX',
      DEFAULT_LIMITS['POST /auth/refresh'].max,
    );
    const refreshHashMax = this.getConfigMax(
      'REFRESH_HASH_RL_MAX',
      DEFAULT_LIMITS['POST /auth/refresh:hash'].max,
    );
    const verifyMax = this.getConfigMax(
      'VERIFY_EMAIL_RL_MAX',
      DEFAULT_LIMITS['GET /auth/verify-email'].max,
    );
    const resendMax = this.getConfigMax(
      'RESEND_VERIFICATION_RL_MAX',
      DEFAULT_LIMITS['POST /auth/resend-verification'].max,
    );
    const salesMax = this.getConfigMax(
      'SALES_NOTIFICATION_RL_MAX',
      DEFAULT_LIMITS['POST /admin/notifications/sales'].max,
    );
    this.logger.log(
      `RateLimit guards: auth 5-20/h (refresh ${refreshMax}/h + hash ${refreshHashMax}/h, logout 20/h, logout-all 10/h), checkout ${checkoutMax}/h/user (win ${checkoutWin}ms), cart ${cartMax}/h/user, product ${prodMax}/h/admin, verify ${verifyMax}/h/IP, resend ${resendMax}/h/IP, sales ${salesMax}/h/user (REDIS_URL ${redisUrl ? 'set, distributed' : 'unset, in-memory'})`,
    );
  }

  /**
   * Determines if request is allowed under rate limits.
   * @param context - Nest execution context (HTTP or GraphQL).
   * @returns true if allowed, throws 429 if exceeded.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = this.extractRequest(context);
    const routeKey = this.resolveRouteKey(req, context);
    const limits = this.getLimitsForRoute(routeKey, req);
    if (!limits || limits.length === 0) return true;

    try {
      // For routes with single bucket (most), handle per-user vs IP
      // For dual-bucket auth routes, handle both
      for (const bucket of limits) {
        const key = this.buildRateLimitKey(
          bucket.routeKey,
          bucket.dim,
          bucket.value,
        );
        const count = ((await this.cache.get<number>(key)) || 0) + 1;
        await this.counterCache().set(key, count, bucket.windowMs);

        if (count > bucket.max) {
          throw this.tooMany(bucket.max, bucket.windowMs);
        }

        // On success, set headers for primary bucket only (first)
        // to avoid overwriting; remaining reflects this bucket
        if (bucket === limits[0]) {
          const res = this.extractResponse(context);
          if (res && typeof res.setHeader === 'function') {
            res.setHeader('X-RateLimit-Limit', String(bucket.max));
            res.setHeader(
              'X-RateLimit-Remaining',
              String(Math.max(0, bucket.max - count)),
            );
          }
        }
      }
    } catch (e) {
      if (
        e instanceof HttpException &&
        e.getStatus() === Number(HttpStatus.TOO_MANY_REQUESTS)
      )
        throw e;
      this.logger.warn(`RateLimit Redis fail-open for ${routeKey}: ${e}`);
    }
    return true;
  }

  /**
   * Resolves route key for throttling.
   * @param req - Express request.
   * @param context - Execution context.
   * @returns Route key like `POST /auth/login` or `products:mutation`.
   */
  private resolveRouteKey(
    req: RateLimitRequest,
    context: ExecutionContext,
  ): string {
    // GraphQL mutations: map to products:mutation bucket if field is product mutation
    try {
      const gqlCtx = GqlExecutionContext.create(context);
      const info = gqlCtx.getInfo?.();
      const fieldName: string | undefined = info?.fieldName;
      const productMutations = new Set([
        'createProduct',
        'createManyProducts',
        'updateProduct',
        'removeProduct',
        'removeAllProducts',
      ]);
      // updateMany is not a resolver field but check generic
      if (
        fieldName &&
        (productMutations.has(fieldName) || fieldName === 'updateMany')
      ) {
        return 'products:mutation';
      }
    } catch {
      // not graphql, fallback to http
    }

    const method: string = req.method || 'UNKNOWN';
    const path: string = req.route?.path || req.path || '';

    // Normalize order complete parameterized path
    // Express may have /order/:id/complete as route.path
    if (path.includes('/order/') && path.includes('/complete')) {
      // keep as POST /order/:id/complete or PATCH
      if (method === 'POST') return 'POST /order/:id/complete';
      if (method === 'PATCH') return 'PATCH /order/:id/complete';
    }
    // Phase 19 — Payment simulation (018): normalize concrete id to the parameterized key
    if (path.includes('/payments/') && path.includes('/confirm')) {
      if (method === 'POST') return 'POST /payments/:id/confirm';
    }
    if (path.includes('/cart/') && method === 'DELETE') {
      return 'DELETE /cart/:cartItemId';
    }

    const raw = `${method} ${path}`.trim();
    // Direct match
    if (DEFAULT_LIMITS[raw]) return raw;
    // Fallback for routeKey with method+path but path may be /order/checkout vs /order
    return raw;
  }

  /**
   * Returns limits for route, applying ConfigService overrides.
   * @param routeKey - Route key.
   * @param req - Request for dimension extraction.
   * @returns Array of buckets to check.
   */
  private getLimitsForRoute(
    routeKey: string,
    req: RateLimitRequest,
  ): RateLimitBucket[] {
    const makeBucket = (
      rk: string,
      dim: string,
      value: string,
      max: number,
      windowMs: number,
    ) => ({ routeKey: rk, dim, value, max, windowMs });

    // Auth dual buckets handled separately
    if (routeKey === 'POST /auth/refresh') {
      const buckets: RateLimitBucket[] = [];
      const ip = this.extractIp(req);
      const ipMax = this.getEffectiveMax(
        routeKey,
        DEFAULT_LIMITS[routeKey].max,
      );
      const ipWin = this.getEffectiveWindow(
        routeKey,
        DEFAULT_LIMITS[routeKey].windowMs,
      );
      buckets.push(makeBucket(routeKey, 'ip', ip, ipMax, ipWin));
      // per-hash bucket 5/h — extract refreshToken from body or cookie
      const raw =
        req.body?.refreshToken ||
        req.cookies?.refresh_token ||
        req.cookies?.refreshToken;
      let hashPrefix: string | null = null;
      if (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)) {
        try {
          const h = crypto
            .createHash('sha256')
            .update(raw)
            .digest('hex')
            .slice(0, 6);
          hashPrefix = h;
        } catch {
          hashPrefix = raw.slice(0, 6);
        }
      } else if (typeof raw === 'string' && raw.length >= 6) {
        hashPrefix = raw.slice(0, 6);
      }
      if (hashPrefix) {
        const hashKey = 'POST /auth/refresh:hash';
        const hashMax = this.getEffectiveMax(
          hashKey,
          DEFAULT_LIMITS[hashKey].max,
        );
        const hashWin = this.getEffectiveWindow(
          hashKey,
          DEFAULT_LIMITS[hashKey].windowMs,
        );
        buckets.push(makeBucket(hashKey, 'hash', hashPrefix, hashMax, hashWin));
      }
      return buckets;
    }
    if (routeKey === 'POST /auth/logout-all') {
      const userSub: string | undefined = req.user?.sub;
      const dim = userSub ? 'user' : 'ip';
      const value = userSub ? String(userSub) : this.extractIp(req);
      const max = this.getEffectiveMax(routeKey, DEFAULT_LIMITS[routeKey].max);
      const windowMs = this.getEffectiveWindow(
        routeKey,
        DEFAULT_LIMITS[routeKey].windowMs,
      );
      return [makeBucket(routeKey, dim, value, max, windowMs)];
    }
    if (routeKey === 'POST /auth/forgot-password') {
      const buckets: RateLimitBucket[] = [];
      const ip = this.extractIp(req);
      const ipMax = this.getEffectiveMax(
        routeKey,
        DEFAULT_LIMITS[routeKey].max,
      );
      const ipWin = this.getEffectiveWindow(
        routeKey,
        DEFAULT_LIMITS[routeKey].windowMs,
      );
      buckets.push(makeBucket(routeKey, 'ip', ip, ipMax, ipWin));
      // per-email only if body.email is a non-empty string (keys are strings;
      // non-string garbage still counts the IP bucket, then 400s at validation)
      if (typeof req.body?.email === 'string' && req.body.email) {
        const email = req.body.email.toLowerCase();
        const emailKey = 'POST /auth/forgot-password:email';
        const emailMax = this.getEffectiveMax(
          emailKey,
          DEFAULT_LIMITS[emailKey].max,
        );
        const emailWin = this.getEffectiveWindow(
          emailKey,
          DEFAULT_LIMITS[emailKey].windowMs,
        );
        buckets.push(makeBucket(emailKey, 'email', email, emailMax, emailWin));
      }
      return buckets;
    }
    if (routeKey === 'POST /auth/otp/request') {
      const buckets: RateLimitBucket[] = [];
      // per-phone only for string phones (same key-string rule as email above)
      const phone = req.body?.phoneNumber;
      if (typeof phone === 'string' && phone) {
        const phoneMax = this.getEffectiveMax(
          routeKey,
          DEFAULT_LIMITS[routeKey].max,
        );
        const phoneWin = this.getEffectiveWindow(
          routeKey,
          DEFAULT_LIMITS[routeKey].windowMs,
        );
        buckets.push(makeBucket(routeKey, 'phone', phone, phoneMax, phoneWin));
      }
      const ip = this.extractIp(req);
      const ipKey = 'POST /auth/otp/request:ip';
      const ipMax = this.getEffectiveMax(ipKey, DEFAULT_LIMITS[ipKey].max);
      const ipWin = this.getEffectiveWindow(
        ipKey,
        DEFAULT_LIMITS[ipKey].windowMs,
      );
      buckets.push(makeBucket(ipKey, 'ip', ip, ipMax, ipWin));
      return buckets;
    }
    if (routeKey === 'POST /auth/resend-verification') {
      const buckets: RateLimitBucket[] = [];
      const ip = this.extractIp(req);
      const ipMax = this.getEffectiveMax(
        routeKey,
        DEFAULT_LIMITS[routeKey].max,
      );
      const ipWin = this.getEffectiveWindow(
        routeKey,
        DEFAULT_LIMITS[routeKey].windowMs,
      );
      buckets.push(makeBucket(routeKey, 'ip', ip, ipMax, ipWin));
      // Per-email bucket only when body.email is a string (same key rule)
      if (typeof req.body?.email === 'string' && req.body.email) {
        const email = req.body.email.toLowerCase();
        const emailKey = 'POST /auth/resend-verification:email';
        const emailMax = this.getEffectiveMax(
          emailKey,
          DEFAULT_LIMITS[emailKey].max,
        );
        const emailWin = this.getEffectiveWindow(
          emailKey,
          DEFAULT_LIMITS[emailKey].windowMs,
        );
        buckets.push(makeBucket(emailKey, 'email', email, emailMax, emailWin));
      }
      return buckets;
    }

    // Order / Cart / Product / Sales per-user logic
    const perUserRoutes = new Set([
      'POST /order/checkout',
      'POST /order',
      'POST /order/:id/complete',
      'PATCH /order/:id/complete',
      'POST /cart',
      'PATCH /cart/increase',
      'PATCH /cart/decrease',
      'DELETE /cart',
      'DELETE /cart/:cartItemId',
      'products:mutation',
      'POST /admin/notifications/sales',
      'POST /admin/notifications/test-email',
      // Phase 19 — Payment simulation (018): per-user buckets, same quota as checkout
      'POST /payments/intent',
      'POST /payments/:id/confirm',
    ]);

    if (perUserRoutes.has(routeKey)) {
      const userSub: string | undefined = req.user?.sub;
      // per-user only if authenticated, else fallback to IP
      const dim = userSub ? 'user' : 'ip';
      const value = userSub ? String(userSub) : this.extractIp(req);
      const max = this.getEffectiveMax(
        routeKey,
        DEFAULT_LIMITS[routeKey]?.max ?? 60,
      );
      const windowMs = this.getEffectiveWindow(
        routeKey,
        DEFAULT_LIMITS[routeKey]?.windowMs ?? 3600_000,
      );
      return [makeBucket(routeKey, dim, value, max, windowMs)];
    }

    // Standard single-bucket auth routes
    const def = DEFAULT_LIMITS[routeKey];
    if (!def) return [];
    const ip = this.extractIp(req);
    const max = this.getEffectiveMax(routeKey, def.max);
    const windowMs = this.getEffectiveWindow(routeKey, def.windowMs);
    return [makeBucket(routeKey, 'ip', ip, max, windowMs)];
  }

  /**
   * Typed view of the injected cache for fixed-window counters
   * (single documented cast).
   *
   * @returns The cache as a counter port.
   */
  private counterCache(): RateLimitCounterCache {
    return this.cache;
  }

  /**
   * Builds rate-limit key.
   * @param routeKey - Route key.
   * @param dim - Dimension (ip, email, phone, user).
   * @param value - Dimension value.
   * @returns Key `rl:{routeKey}:{dim}:{value}`.
   */
  private buildRateLimitKey(
    routeKey: string,
    dim: string,
    value: string,
  ): string {
    return `rl:${routeKey}:${dim}:${value}`;
  }

  /**
   * Extracts client IP deterministically.
   * @param req - Request.
   * @returns IP string.
   */
  private extractIp(req: RateLimitRequest): string {
    const header = req.headers?.['x-forwarded-for'];
    // x-forwarded-for may be "a,b,c" -> take first trimmed
    const firstHeader = Array.isArray(header) ? header[0] : header;
    if (firstHeader) {
      const first = firstHeader.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.ip || 'unknown';
  }

  /**
   * Extracts request (HTTP or GraphQL).
   * @param context - Execution context.
   * @returns Request object.
   */
  private extractRequest(context: ExecutionContext): RateLimitRequest {
    try {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlReq = gqlCtx.getContext()?.req as RateLimitRequest | undefined;
      if (gqlReq) return gqlReq;
    } catch {
      // ignore
    }
    return context.switchToHttp().getRequest<Request>();
  }

  /**
   * Extracts response for header setting.
   * @param context - Execution context.
   * @returns Response or null.
   */
  private extractResponse(context: ExecutionContext): RateLimitResponse | null {
    try {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlCtxObj = gqlCtx.getContext();
      if (gqlCtxObj?.res) return gqlCtxObj.res;
    } catch {
      // ignore
    }
    try {
      return context.switchToHttp().getResponse<RateLimitResponse>();
    } catch {
      return null;
    }
  }

  /**
   * Gets max from config with fallback.
   * @param routeKey - Route key.
   * @param fallback - Default max.
   * @returns Effective max.
   */
  private getEffectiveMax(routeKey: string, fallback: number): number {
    const envMap: Record<string, string> = {
      'POST /order/checkout': 'ORDER_CHECKOUT_RL_MAX',
      'POST /order': 'ORDER_CHECKOUT_RL_MAX',
      'POST /order/:id/complete': 'ORDER_COMPLETE_RL_MAX',
      'PATCH /order/:id/complete': 'ORDER_COMPLETE_RL_MAX',
      'POST /cart': 'CART_RL_MAX',
      'PATCH /cart/increase': 'CART_RL_MAX',
      'PATCH /cart/decrease': 'CART_RL_MAX',
      'DELETE /cart': 'CART_RL_MAX',
      'DELETE /cart/:cartItemId': 'CART_RL_MAX',
      'products:mutation': 'PRODUCT_MUTATION_RL_MAX',
      'POST /auth/refresh': 'REFRESH_RL_MAX',
      'POST /auth/refresh:hash': 'REFRESH_HASH_RL_MAX',
      'POST /auth/logout': 'LOGOUT_RL_MAX',
      'POST /auth/logout-all': 'LOGOUT_ALL_RL_MAX',
      'GET /auth/verify-email': 'VERIFY_EMAIL_RL_MAX',
      'POST /auth/verify-email': 'VERIFY_EMAIL_RL_MAX',
      'POST /auth/resend-verification': 'RESEND_VERIFICATION_RL_MAX',
      'POST /auth/resend-verification:email':
        'RESEND_VERIFICATION_EMAIL_RL_MAX',
      'POST /admin/notifications/sales': 'SALES_NOTIFICATION_RL_MAX',
      // Phase 19 — Payment simulation (018): driven by the checkout quota (Q3/D6)
      'POST /payments/intent': 'ORDER_CHECKOUT_RL_MAX',
      'POST /payments/:id/confirm': 'ORDER_CHECKOUT_RL_MAX',
    };
    const envKey = envMap[routeKey];
    if (!envKey) return fallback;
    return this.getConfigMax(envKey, fallback);
  }

  /**
   * Gets windowMs from config with fallback and clamp.
   * @param routeKey - Route key.
   * @param fallback - Default windowMs.
   * @returns Effective windowMs clamped >=60000.
   */
  private getEffectiveWindow(routeKey: string, fallback: number): number {
    const envMap: Record<string, string> = {
      'POST /order/checkout': 'ORDER_CHECKOUT_RL_WINDOW_MS',
      'POST /order': 'ORDER_CHECKOUT_RL_WINDOW_MS',
      'POST /order/:id/complete': 'ORDER_COMPLETE_RL_WINDOW_MS',
      'PATCH /order/:id/complete': 'ORDER_COMPLETE_RL_WINDOW_MS',
      'POST /cart': 'CART_RL_WINDOW_MS',
      'PATCH /cart/increase': 'CART_RL_WINDOW_MS',
      'PATCH /cart/decrease': 'CART_RL_WINDOW_MS',
      'DELETE /cart': 'CART_RL_WINDOW_MS',
      'DELETE /cart/:cartItemId': 'CART_RL_WINDOW_MS',
      'products:mutation': 'PRODUCT_MUTATION_RL_WINDOW_MS',
      'POST /auth/refresh': 'REFRESH_RL_WINDOW_MS',
      'POST /auth/refresh:hash': 'REFRESH_HASH_RL_WINDOW_MS',
      'POST /auth/logout': 'LOGOUT_RL_WINDOW_MS',
      'POST /auth/logout-all': 'LOGOUT_ALL_RL_WINDOW_MS',
      'GET /auth/verify-email': 'VERIFY_EMAIL_RL_WINDOW_MS',
      'POST /auth/verify-email': 'VERIFY_EMAIL_RL_WINDOW_MS',
      'POST /auth/resend-verification': 'RESEND_VERIFICATION_RL_WINDOW_MS',
      'POST /auth/resend-verification:email':
        'RESEND_VERIFICATION_EMAIL_RL_WINDOW_MS',
      'POST /admin/notifications/sales': 'SALES_NOTIFICATION_RL_WINDOW_MS',
      // Phase 19 — Payment simulation (018): driven by the checkout window (Q3/D6)
      'POST /payments/intent': 'ORDER_CHECKOUT_RL_WINDOW_MS',
      'POST /payments/:id/confirm': 'ORDER_CHECKOUT_RL_WINDOW_MS',
    };
    const envKey = envMap[routeKey];
    if (!envKey) return fallback;
    return this.getConfigWindow(envKey, fallback);
  }

  /**
   * Parses max from ConfigService.
   * @param key - Env key.
   * @param fallback - Fallback max.
   * @returns Parsed max or fallback with warn.
   */
  private getConfigMax(key: string, fallback: number): number {
    const raw = this.configService?.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `Invalid rate-limit max config ${key}="${raw}", fallback to ${fallback}`,
      );
      return fallback;
    }
    return parsed;
  }

  /**
   * Parses windowMs from ConfigService with clamp.
   * @param key - Env key.
   * @param fallback - Fallback window.
   * @returns Clamped windowMs.
   */
  private getConfigWindow(key: string, fallback: number): number {
    const raw = this.configService?.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 60000) {
      this.logger.warn(
        `Invalid rate-limit window config ${key}="${raw}", fallback to ${fallback} (min 60000)`,
      );
      return fallback;
    }
    return parsed;
  }

  /**
   * Creates 429 exception with B1 headers.
   * @param limit - Limit that was exceeded.
   * @param windowMs - Window for Retry-After.
   * @returns HttpException 429.
   */
  private tooMany(limit: number, windowMs: number = 3600_000): HttpException {
    // Retry-After in seconds, rounded UP so the client never retries early.
    const retryAfter = String(Math.ceil(windowMs / 1000));
    const ex = new HttpException(
      'Too Many Requests',
      HttpStatus.TOO_MANY_REQUESTS,
    );
    (ex as unknown as RateLimitHeadersCarrier).options = {
      headers: {
        'Retry-After': retryAfter,
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
      },
    };
    return ex;
  }
}
