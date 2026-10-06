import { INestApplication, Logger } from '@nestjs/common';

/**
 * CORS allow-list helpers (S1 P0-7).
 * Credentialed browser access is limited to explicitly configured origins;
 * requests without an Origin header (non-browser clients) are unaffected.
 */

/** Resolved inputs for CORS configuration (all from ConfigService at boot). */
export interface CorsSettings {
  frontendUrl?: string;
  extraOrigins?: string;
  nodeEnv?: string;
}

/**
 * Builds the CORS origin allow-list from configuration.
 *
 * @param settings - Raw config values (frontend URL + optional comma-separated list).
 * @returns Trimmed, non-empty origins with the frontend URL first.
 */
export function buildCorsAllowList(settings: CorsSettings): string[] {
  const extraOrigins = (settings.extraOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const frontendUrl = (settings.frontendUrl ?? '').trim();
  const allowList = frontendUrl.length > 0 ? [frontendUrl] : [];
  for (const origin of extraOrigins) {
    // Deduplicate so echoed config cannot produce duplicate entries.
    if (!allowList.includes(origin)) allowList.push(origin);
  }
  return allowList;
}

/**
 * Applies CORS to the application with fail-closed production semantics.
 *
 * @param app - The Nest application to configure.
 * @param settings - Raw config values (see CorsSettings).
 * @param logger - Logger used for the empty-list warning (defaults to module logger).
 */
export function configureCors(
  app: INestApplication,
  settings: CorsSettings,
  logger: Logger = new Logger('Cors'),
): void {
  const allowList = buildCorsAllowList(settings);
  if (allowList.length > 0) {
    app.enableCors({ origin: allowList, credentials: true });
    return;
  }
  // No origins configured: fail closed in production, warn-and-reflect in dev
  // (dev keeps the previous ergonomics explicitly, never silently).
  logger.warn(
    'CORS allow-list is empty: production rejects credentialed origins',
  );
  if (settings.nodeEnv === 'production') {
    app.enableCors({ origin: false });
  } else {
    app.enableCors({ origin: true, credentials: true });
  }
}
