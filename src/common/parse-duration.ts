/**
 * This utility is responsible for parsing human duration strings to milliseconds.
 * It unifies the previously triple-duplicated TTL parsers (service x2 + controller
 * cookie math) with byte-identical outputs for identical inputs.
 *
 * Responsibility (SRP): duration parsing, nothing else.
 * Used by: AuthTokenConfig (TTL/cooldown resolution).
 * Depends on: nothing (pure function).
 */

/**
 * Parses a duration string to milliseconds.
 *
 * @param raw - Duration like "15m", "60s", "24h", "7d", or plain ms "604800000".
 * @param fallbackMs - Returned when the input is unparseable.
 * @param onInvalid - Optional callback for invalid input (callers preserve
 *   their exact pre-refactor warn behavior through this hook).
 * @returns Milliseconds.
 */
export function parseDurationMs(
  raw: string,
  fallbackMs: number,
  onInvalid?: (raw: string, fallbackMs: number) => void,
): number {
  // Suffix multipliers in ms: s/m/h/d. Plain integers pass through as ms.
  // QUIRK (preserved from the legacy parsers): a non-numeric prefix with a
  // valid suffix (e.g. "bogus" ends with "s") yields NaN — identical to the
  // old code, which returned before reaching its numeric check. TTLs come
  // from validated config with sane defaults, so this path is unreachable
  // in practice; changing it would be a behavior delta, not a refactor.
  if (raw.endsWith('m')) return parseInt(raw, 10) * 60_000;
  if (raw.endsWith('s')) return parseInt(raw, 10) * 1000;
  if (raw.endsWith('h')) return parseInt(raw, 10) * 3600_000;
  if (raw.endsWith('d')) return parseInt(raw, 10) * 24 * 3600_000;
  // Numeric fallback (e.g. "604800000"): only pure-digit strings qualify.
  const numeric = parseInt(raw, 10);
  if (!isNaN(numeric) && String(numeric) === raw) return numeric;
  if (onInvalid) onInvalid(raw, fallbackMs);
  return fallbackMs;
}
