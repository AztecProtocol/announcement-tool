/**
 * GET /admin/login — starts the Auth0 Authorization Code + PKCE browser flow.
 *
 * Why this exists: middleware.ts authenticates admin requests by verifying an
 * RS256 Auth0 JWT from an `Authorization: Bearer` header. A browser tab cannot
 * send that header on an ordinary navigation, so without this flow there is no
 * way to sign in with a browser at all. This route sends the user to Auth0; the
 * callback turns the result into a signed session cookie.
 *
 * Two values are minted here and stashed in short-lived HttpOnly cookies so the
 * callback can check them:
 *
 *   - `state` — CSRF protection. Without it, an attacker can feed a victim's
 *     browser an authorization code of the attacker's choosing and land the
 *     victim in the attacker's session (or the reverse). Not optional.
 *   - `code_verifier` — PKCE. Binds the authorization code to this specific
 *     browser, so a code intercepted in the redirect is useless without the
 *     verifier, which never leaves the cookie jar.
 *
 * Both cookies are HttpOnly so page JavaScript cannot read them, and SameSite=Lax
 * so they survive the top-level redirect back from Auth0 (Strict does not — that
 * is a silent login loop).
 *
 * Nothing here is logged. The verifier is key material and the state is a CSRF
 * token; neither ever reaches a log line.
 *
 * All the decidable logic (URL building, PKCE derivation) lives in
 * src/core/auth0-login.ts, where the test suite can reach it — code in app/
 * cannot be imported by vitest.
 */
import { auth0ConfigFromEnv } from '../../../src/core/auth0-verify.js';
import {
  buildAuthorizeUrl, createCodeVerifier, createState, deriveCodeChallenge,
  loginErrorRedirect, CALLBACK_PATH, STATE_COOKIE, VERIFIER_COOKIE,
  TRANSIENT_COOKIE_MAX_AGE,
} from '../../../src/core/auth0-login.js';
import { publicBaseUrl } from '../../../src/core/public-base-url.js';

export const dynamic = 'force-dynamic';

function baseUrl(): string {
  return publicBaseUrl();
}

/**
 * The callback URL must be absolute (Auth0 requires it) and must match a
 * registered Allowed Callback URL exactly. Derived from PUBLIC_BASE_URL rather
 * than the inbound Host header: Host is client-controlled, and letting it steer
 * the redirect URI would let an attacker point the code at a host they own.
 */
function callbackUrl(): string {
  return `${baseUrl()}${CALLBACK_PATH}`;
}

export async function GET(): Promise<Response> {
  const config = auth0ConfigFromEnv(process.env);
  const clientId = process.env.AUTH0_CLIENT_ID;

  // Missing configuration must fail closed. There is no "log in without Auth0"
  // fallback here — that would be an unauthenticated route to admin identity.
  //
  // A plain relative `location`, matching the callback and logout routes. Do not
  // resolve this against callbackUrl(): that base is /admin/callback, so any
  // future error path that returned a path without a leading slash would land on
  // /admin/admin instead of /admin.
  if (!config || !clientId) {
    return new Response(null, {
      status: 303,
      headers: { location: loginErrorRedirect('config'), 'cache-control': 'no-store' },
    });
  }

  const state = createState();
  const verifier = createCodeVerifier();

  const authorizeUrl = buildAuthorizeUrl({
    issuer: config.issuer,
    clientId,
    redirectUri: callbackUrl(),
    state,
    codeChallenge: deriveCodeChallenge(verifier),
  });

  const headers = new Headers({ location: authorizeUrl });
  headers.append('set-cookie', transientCookie(STATE_COOKIE, state));
  headers.append('set-cookie', transientCookie(VERIFIER_COOKIE, verifier));
  // Never let an intermediary or the browser cache a response carrying
  // single-use CSRF and PKCE material.
  headers.set('cache-control', 'no-store');

  return new Response(null, { status: 303, headers });
}

/**
 * Path is `/admin` — the same scope as the session cookie — so these are sent
 * to the callback but not to the public site. Secure is unconditional: this
 * deployment is HTTPS-only, and a downgraded cookie would leak the verifier.
 */
function transientCookie(name: string, value: string): string {
  return [
    `${name}=${value}`,
    'Path=/admin',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${TRANSIENT_COOKIE_MAX_AGE}`,
  ].join('; ');
}
