/**
 * Shared Auth0 ID/access-token verification: issuer normalisation, JWKS caching,
 * and the `jwtVerify` call itself.
 *
 * ⚠️ This module is part of the trust boundary for admin identity. ⚠️
 *
 * Two callers depend on it, and they must agree exactly:
 *
 *   - middleware.ts verifies the RS256 bearer token on every /admin request.
 *   - app/admin/callback/route.ts verifies the ID token returned by the Auth0
 *     token endpoint during the browser login flow.
 *
 * Both mint the same trusted identity — one via an internal request header, the
 * other via a signed session cookie — and every four-eyes approval for a
 * `critical` announcement (an irreversible Discord role ping) rests on that
 * identity being unforgeable. If the two callers verified tokens with different
 * rules, the weaker one would silently become the way in. That is why
 * this logic lives in one module instead of being copied: two copies will drift,
 * and the drift is not visible at either call site.
 *
 * Everything here fails closed. Missing configuration, a bad signature, a wrong
 * issuer or audience, an expired token, or a JWKS fetch failure all produce
 * `undefined` — never a partially-checked payload, and never an exception that a
 * caller might mistake for an unrelated error.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Auth0 sets AUTH0_ISSUER with a trailing slash, and the `iss` claim in a token
 * it mints always carries one. A configured value missing the slash would fail
 * every verification with a confusing "unexpected iss" error, so tolerate it
 * either way rather than making operators guess the exact form.
 */
export function normalizeIssuer(raw: string): string {
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * `createRemoteJWKSet` caches the fetched key set and handles Auth0's key
 * rotation internally, so it must be created once per process rather than per
 * request. Building it per request would refetch the JWKS on every admin
 * navigation and turn a slow Auth0 response into a login outage.
 *
 * Keyed by issuer so that a changed issuer (a redeploy pointed at a different
 * tenant) rebuilds the set rather than silently validating against the old
 * tenant's keys.
 */
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByIssuer.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer));
    jwksByIssuer.set(issuer, set);
  }
  return set;
}

/** The Auth0 configuration both callers need, resolved from the environment. */
export interface Auth0Config {
  /** Normalised, always trailing-slashed. */
  issuer: string;
  audience: string;
}

/**
 * The environment variables this module reads. The index signature is
 * what lets `process.env` be passed directly: every field here is optional, so
 * without it the type shares no required property with `ProcessEnv` and TS
 * rejects the call as having no overlap.
 */
export interface Auth0Env {
  AUTH0_ISSUER?: string | undefined;
  AUTH0_DOMAIN?: string | undefined;
  AUTH0_AUDIENCE?: string | undefined;
  AUTH0_CLIENT_ID?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Reads the Auth0 issuer and audience from an environment-shaped object,
 * applying the same fallbacks middleware.ts has always applied: `AUTH0_ISSUER`
 * or the `https://{AUTH0_DOMAIN}/` derived form, and `AUTH0_AUDIENCE` or
 * `AUTH0_CLIENT_ID`.
 *
 * Returns `undefined` when either is missing. Missing config must never mean
 * "skip the check and trust the token" — it means the caller denies. Taking the
 * environment as an argument (typed to just the four variables it reads, so
 * `process.env` satisfies it structurally) keeps this testable without mutating
 * globals.
 */
export function auth0ConfigFromEnv(env: Auth0Env): Auth0Config | undefined {
  const issuerRaw = env.AUTH0_ISSUER ?? (env.AUTH0_DOMAIN ? `https://${env.AUTH0_DOMAIN}/` : undefined);
  const audience = env.AUTH0_AUDIENCE ?? env.AUTH0_CLIENT_ID;
  if (!issuerRaw || !audience) return undefined;
  return { issuer: normalizeIssuer(issuerRaw), audience };
}

/**
 * Verifies an Auth0-minted RS256 JWT and returns its payload, or `undefined` on
 * any failure.
 *
 * `jwtVerify` checks the RS256 signature against the tenant's JWKS and enforces
 * `iss`, `aud`, `exp` and `nbf`. Checking the signature alone would accept a
 * valid token minted for a different application in the same tenant, so the
 * issuer and audience are always passed.
 *
 * `algorithms` is pinned to RS256 so a token whose header claims a different
 * algorithm cannot steer verification somewhere weaker.
 *
 * Never throws and never logs: the reason for a denial is deliberately not
 * surfaced, because it is attacker-influenced and can carry token material.
 */
export async function verifyAuth0Token(
  token: string,
  config: Auth0Config,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { payload } = await jwtVerify(token, getJwks(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
    });
    return payload as Record<string, unknown>;
  } catch {
    // Bad signature, wrong issuer/audience, expired, or JWKS fetch failure.
    // All of them deny.
    return undefined;
  }
}
