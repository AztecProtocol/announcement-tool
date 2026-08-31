/**
 * ⚠️ GET /admin/callback — this route mints admin identity. Read before editing. ⚠️
 *
 * Auth0 redirects here with an authorization code. This route turns that code
 * into a signed session cookie that middleware.ts will accept as proof
 * of who the caller is. That makes it the second entrance to the same trust
 * boundary middleware.ts guards, and everything the four-eyes rule protects —
 * a `critical` announcement is an irreversible Discord role ping that needs two
 * different publishers — rests on it not being bypassable.
 *
 * The order below matters. Do not reorder it:
 *
 *   1. Compare `state` to the cookie. Mismatch or missing → refuse without
 *      exchanging. Exchanging first and checking later would still burn the
 *      code and still be CSRF-vulnerable.
 *   2. Exchange the code at Auth0's token endpoint, sending the PKCE
 *      `code_verifier` from its HttpOnly cookie.
 *   3. Verify the returned ID token — signature, issuer, audience, expiry —
 *      against the tenant JWKS. See the warning below.
 *   4. `emailFromClaims` on the verified payload. Undefined → refuse.
 *   5. Set the session cookie.
 *   6. Clear the transient cookies and redirect to /admin.
 *
 * ⚠️ Why step 3 is not optional, even though the token came from Auth0 over
 * direct HTTPS: it is tempting to decode the ID token and trust its claims
 * because we fetched it ourselves from the tenant. Do not. The verification
 * pins the issuer and the audience, and an unverified decode would accept a
 * token minted for a different application in the same tenant, or one whose
 * signature never checked out at all. It also keeps this route's rules
 * identical to middleware.ts's — both call the same helper in
 * src/core/auth0-verify.ts precisely so the two cannot drift apart.
 *
 * Failure handling: every failure redirects to `/admin?login_error=<slug>` with
 * an opaque slug. The underlying Auth0 error is never rendered and never logged:
 * `error_description` can carry internal detail, and the code, tokens, verifier
 * and cookie values are all secrets. Nothing sensitive is logged at any level.
 */
import { auth0ConfigFromEnv, verifyAuth0Token } from '../../../src/core/auth0-verify.js';
import { emailFromClaims } from '../../../src/core/auth0-claims.js';
import { SESSION_COOKIE, signSession } from '../../../src/core/session.js';
import {
  buildTokenRequestBody, idTokenFromResponse, loginErrorRedirect, stateMatches,
  tokenEndpoint, CALLBACK_PATH, STATE_COOKIE, VERIFIER_COOKIE, type LoginError,
} from '../../../src/core/auth0-login.js';

export const dynamic = 'force-dynamic';

/** 12 hours, matching signSession's default TTL so the cookie and the JWT expire together. */
const SESSION_MAX_AGE = 12 * 60 * 60;

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'https://announce.aztec.foundation').replace(/\/+$/, '');
}

/**
 * Every exit from this route clears the transient cookies, success or failure.
 * A state or verifier cookie left behind is single-use material lingering in
 * the browser for no reason.
 */
function respond(location: string, extraCookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of extraCookies) headers.append('set-cookie', cookie);
  headers.append('set-cookie', clearCookie(STATE_COOKIE));
  headers.append('set-cookie', clearCookie(VERIFIER_COOKIE));
  return new Response(null, { status: 303, headers });
}

const fail = (error: LoginError): Response => respond(loginErrorRedirect(error));

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));

  // ── Step 1 — state, checked before any exchange ──────────────────────────
  // Constant-time comparison; fails closed on a missing cookie or param.
  if (!stateMatches(cookies.get(STATE_COOKIE), url.searchParams.get('state'))) {
    return fail('state');
  }

  // Auth0 reports user-facing failures (consent denied, etc.) as `error` on the
  // redirect. Treated as a plain refusal — the description is never surfaced.
  if (url.searchParams.get('error')) return fail('provider');

  const code = url.searchParams.get('code');
  const verifier = cookies.get(VERIFIER_COOKIE);
  if (!code || !verifier) return fail('state');

  const config = auth0ConfigFromEnv(process.env);
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  // Missing config denies. It must never mean "skip verification".
  if (!config || !clientId || !clientSecret || !sessionSecret) return fail('config');

  // ── Step 2 — exchange the code ────────────────────────────────────────────
  // Auth0 requires application/x-www-form-urlencoded here, not JSON.
  let idToken: string | undefined;
  try {
    const response = await fetch(tokenEndpoint(config.issuer), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: buildTokenRequestBody({
        clientId,
        clientSecret,
        code,
        codeVerifier: verifier,
        redirectUri: `${baseUrl()}${CALLBACK_PATH}`,
      }),
      cache: 'no-store',
    });

    // A non-2xx carries an {error, error_description} body. Deliberately not
    // read, not logged, not surfaced.
    if (!response.ok) return fail('exchange');

    idToken = idTokenFromResponse(await response.json());
  } catch {
    // Network failure or unparseable body. Denies, without detail.
    return fail('exchange');
  }

  if (!idToken) return fail('exchange');

  // ── Step 3 — verify the ID token ──────────────────────────────────────────
  // Signature, issuer, audience and expiry, against the tenant JWKS. Shared
  // with middleware.ts so the two verifications cannot diverge.
  const payload = await verifyAuth0Token(idToken, config);
  if (!payload) return fail('token');

  // ── Step 4 — claim policy ──────────────────────────────────────────────────
  // emailFromClaims already enforces `email_verified === true`; do not add a
  // second, competing claim check here.
  const email = emailFromClaims(payload);
  if (!email) return fail('identity');

  // ── Step 5 — mint the session cookie ──────────────────────────────────────
  let session: string;
  try {
    session = await signSession(email, sessionSecret);
  } catch {
    return fail('identity');
  }

  // ── Step 6 — set, clear, redirect ─────────────────────────────────────────
  return respond('/admin', [sessionCookie(session)]);
}

/**
 * SameSite=Lax is required, not a preference: Strict would withhold the cookie
 * on the cross-site navigation back from Auth0, so /admin would not see the
 * session it was just given and would bounce the user back to login forever.
 *
 * Path=/admin scopes it to the only surface that consumes identity. HttpOnly
 * keeps it away from page JavaScript; Secure keeps it off plaintext HTTP.
 */
function sessionCookie(value: string): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/admin',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ].join('; ');
}

function clearCookie(name: string): string {
  return `${name}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Minimal cookie-header parser. Only the first occurrence of a name wins, so a
 * duplicate injected later in the header cannot override the real value.
 */
function parseCookies(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || jar.has(name)) continue;
    jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}
