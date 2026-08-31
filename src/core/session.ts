/**
 * The browser-side session cookie for the login flow.
 *
 * middleware.ts already trusts a verified Auth0 RS256 `Authorization: Bearer`
 * token as proof of identity, but a browser tab never sends that header — there
 * is no way to attach it to an ordinary navigation. This module gives the login
 * flow a second way to prove the same thing: a signed cookie the browser sends
 * automatically on every request.
 *
 * Because that cookie becomes an alternate path to a trusted identity, and every
 * four-eyes approval for a `critical` announcement (irreversible Discord role
 * ping) depends on trusting that identity, the cookie must be at least as hard to
 * forge as the Auth0 token it stands in for. It is therefore signed with HS256
 * via `jose` — the same library middleware.ts already uses for RS256 — and never
 * merely encoded. `verifySession` fails closed on every malformed or tampered
 * input rather than throwing, so a forged or corrupted cookie is a clean denial,
 * not a 500.
 */
import { SignJWT, jwtVerify, errors } from 'jose';

export const SESSION_COOKIE = 'announce_session';

/**
 * 12 hours: long enough to cover one working day without re-authenticating,
 * short enough that a stolen cookie is only useful for a bounded window.
 */
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

const EMAIL_CLAIM = 'sub';

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Rejects an empty or whitespace-only email at signing time. Mirrors the rule in
 * `emailFromClaims`: a blank identity must never be able to satisfy four-eyes, so
 * it must never even make it into a signed cookie in the first place.
 */
function assertNonBlankEmail(email: string): void {
  if (email.trim().length === 0) {
    throw new Error('signSession: email must not be empty or whitespace-only');
  }
}

export async function signSession(
  email: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  assertNonBlankEmail(email);

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ [EMAIL_CLAIM]: email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(encodeSecret(secret));
}

/**
 * Verifies the signature and expiry of a session cookie value and returns the
 * email it carries, or `undefined` on any failure — bad signature, wrong secret,
 * expired token, malformed input, or a blank/missing email claim. Never throws:
 * a forged or corrupted cookie must produce a clean denial, not a 500.
 */
export async function verifySession(value: string, secret: string): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(value, encodeSecret(secret), {
      algorithms: ['HS256'],
    });

    const email = payload[EMAIL_CLAIM];
    if (typeof email !== 'string') return undefined;

    const trimmed = email.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if (err instanceof errors.JOSEError) return undefined;
    // Any other unexpected failure (malformed compact serialization, etc.) is
    // still a denial, never a throw to the caller.
    return undefined;
  }
}
