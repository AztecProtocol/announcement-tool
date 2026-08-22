/**
 * Pure, network-free helpers for the Auth0 Authorization Code + PKCE browser
 * login flow. The three route handlers under `app/admin/` are thin wrappers
 * around these functions.
 *
 * WHY THE LOGIC LIVES HERE AND NOT IN THE ROUTES. Code inside `app/` cannot be
 * reached by the vitest suite — importing a Next.js route handler drags in the
 * framework runtime. These routes ALSO cannot be exercised end-to-end without a
 * live Auth0 tenant. So everything decidable without a tenant — URL building,
 * PKCE derivation, the state comparison, and the token-response shape check —
 * is pulled out to this module where it is unit-testable, and the routes keep
 * only the parts that genuinely need a request, a cookie jar, or the network.
 *
 * The state comparison in particular is CSRF protection standing between an
 * attacker and a session cookie for an identity they do not control, and every
 * four-eyes approval on a `critical` announcement (an IRREVERSIBLE Discord role
 * ping) depends on that identity. It must be tested, so it must not live in a
 * route handler.
 *
 * Docs this implements (fetched 2026-08-22):
 *   - https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce
 *   - https://auth0.com/docs/api/authentication/authorization-code-flow-with-pkce/get-token-pkce
 *   - https://datatracker.ietf.org/doc/html/rfc7636 (PKCE; §4.1 verifier, §4.2 challenge)
 *   - https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Cookie holding the per-request CSRF `state` value while the user is at Auth0. */
export const STATE_COOKIE = 'announce_oauth_state';
/** Cookie holding the PKCE `code_verifier` while the user is at Auth0. */
export const VERIFIER_COOKIE = 'announce_oauth_verifier';

/**
 * 10 minutes. These two cookies only need to outlive a single trip to the Auth0
 * login screen. A short life limits how long a captured verifier is worth
 * anything, and Auth0 authorization codes are themselves short-lived.
 */
export const TRANSIENT_COOKIE_MAX_AGE = 600;

/** Where the callback lands. Also the value registered in Auth0's Allowed Callback URLs. */
export const CALLBACK_PATH = '/admin/callback';

/**
 * RFC 7636 §4.1 recommends a 32-octet random sequence, base64url-encoded, which
 * yields exactly 43 characters — the minimum legal verifier length. The grammar
 * is `43*128unreserved`, and base64url output is a strict subset of `unreserved`,
 * so this is always well-formed.
 */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * RFC 7636 §4.2: `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`.
 *
 * Node's 'base64url' encoding is the RFC 4648 §5 URL-safe alphabet with padding
 * already stripped, which is exactly what the spec requires ("all trailing '='
 * characters omitted"). Do NOT switch this to 'base64' and post-process — that
 * is where implementations usually introduce a stray '=' and get an opaque
 * `invalid_grant` from Auth0.
 *
 * S256 is the only method Auth0 supports, and RFC 7636 makes it mandatory to
 * implement, so `plain` is deliberately not offered here.
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A random, opaque, per-request CSRF token carried through the Auth0 round trip. */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison of the `state` returned by Auth0 against the copy we
 * stored in an HttpOnly cookie.
 *
 * Fails closed on a missing, empty, or length-mismatched value. `timingSafeEqual`
 * THROWS on differing buffer lengths, so the length check must come first — an
 * exception escaping a CSRF check would be a denial by crash at best, and at
 * worst a path a caller wraps in a try/catch that continues.
 */
export function stateMatches(expected: string | undefined, presented: string | null): boolean {
  if (!expected || !presented) return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

export interface AuthorizeUrlParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Builds the Auth0 `/authorize` URL for the PKCE flow.
 *
 * `scope=openid email` is the minimum that yields an ID token carrying the
 * `email` and `email_verified` claims `emailFromClaims` requires. `audience` is
 * deliberately NOT sent: this flow authenticates a human for the admin UI, it
 * does not request an access token for a separate API, and adding an audience
 * would change what Auth0 mints.
 *
 * `URLSearchParams` handles the percent-encoding, so the redirect URI and state
 * are escaped correctly rather than concatenated by hand.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL('authorize', ensureTrailingSlash(params.issuer));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: 'openid email',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/**
 * Builds the legacy `/v2/logout` URL, whose return parameter is camelCase
 * `returnTo` — NOT the `post_logout_redirect_uri` of the newer `/oidc/logout`
 * endpoint. Mixing the two silently drops the redirect.
 *
 * The `returnTo` value must be registered in the application's Allowed Logout
 * URLs or Auth0 refuses the redirect.
 */
export function buildLogoutUrl(issuer: string, clientId: string, returnTo: string): string {
  const url = new URL('v2/logout', ensureTrailingSlash(issuer));
  url.search = new URLSearchParams({ client_id: clientId, returnTo }).toString();
  return url.toString();
}

/** The token endpoint, per the Get Token (PKCE) reference: POST {issuer}oauth/token. */
export function tokenEndpoint(issuer: string): string {
  return new URL('oauth/token', ensureTrailingSlash(issuer)).toString();
}

/**
 * Body for the code exchange. Auth0 expects
 * `application/x-www-form-urlencoded`, NOT JSON — posting JSON here returns an
 * unhelpful error. `client_secret` is included because this is a confidential
 * (regular web) application using `client_secret_post`; a public SPA client
 * would omit it. `redirect_uri` is required because it was sent to /authorize.
 */
export function buildTokenRequestBody(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  }).toString();
}

/**
 * Extracts the `id_token` from a parsed token-endpoint response.
 *
 * Returns `undefined` for any shape that is not an object carrying a non-empty
 * string `id_token`, so a 200 with an error body, a null, or an array cannot
 * reach the verification step as `undefined` and be mistaken for a token.
 *
 * NOTE: the ID token returned here is NOT trusted on the strength of having
 * arrived over HTTPS from Auth0. The caller passes it to `verifyAuth0Token`
 * (src/core/auth0-verify.ts) for full signature/issuer/audience/expiry checking
 * first. This function only reads a field out of JSON.
 */
export function idTokenFromResponse(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const token = (body as Record<string, unknown>).id_token;
  if (typeof token !== 'string') return undefined;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Failure indicators appended to the /admin redirect. Deliberately a small
 * closed set of opaque slugs: the underlying Auth0 error is never surfaced,
 * because its `error_description` can carry internal detail or token material.
 */
export type LoginError =
  | 'config'
  | 'state'
  | 'provider'
  | 'exchange'
  | 'token'
  | 'identity';

/** `/admin?login_error=<slug>` — the ONLY thing a failed login tells the browser. */
export function loginErrorRedirect(error: LoginError): string {
  return `/admin?login_error=${error}`;
}

function ensureTrailingSlash(raw: string): string {
  return raw.endsWith('/') ? raw : `${raw}/`;
}
