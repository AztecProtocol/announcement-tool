import { timingSafeEqual } from 'node:crypto';

/**
 * Verifies that a request to the Netlify tick-background function actually
 * came from tick-scheduled, not from anyone who has guessed or discovered
 * the function's URL. The endpoint is public HTTP with no other auth in
 * front of it, so this shared-secret check is the only gate.
 *
 * Deliberately fails closed: an unset or empty `configured` secret means the
 * deployment is missing TICK_SECRET, and that must refuse every request, not
 * allow them. Treating "no secret configured" as "anyone may call this"
 * would invert the guard exactly when it matters most.
 *
 * Uses a timing-safe comparison so this stays a habit even though the
 * practical timing-attack risk against a background job is low. `timingSafeEqual`
 * throws on mismatched buffer lengths, so the length check must happen first
 * — never let that throw escape as an unhandled exception from an auth check.
 */
export function tickSecretMatches(configured: string | undefined, presented: string | null): boolean {
  if (!configured || !presented) return false;

  const configuredBuf = Buffer.from(configured, 'utf8');
  const presentedBuf = Buffer.from(presented, 'utf8');

  if (configuredBuf.length !== presentedBuf.length) return false;

  return timingSafeEqual(configuredBuf, presentedBuf);
}
