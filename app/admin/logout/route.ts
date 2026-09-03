/**
 * GET /admin/logout — ends the browser session.
 *
 * Clears the session cookie and redirects to `/`.
 *
 * ── Does this also log the user out of Auth0? No, by default. ───────────────
 * This route clears the local session only. The user's Auth0 tenant session
 * survives, so clicking "log in" again signs them straight back in without a
 * password prompt. That is the usual expectation for a shared-tenant internal
 * tool: logging out of this app should not log the person out of every other
 * Auth0-backed application they have open.
 *
 * Set `AUTH0_LOGOUT_REDIRECT=1` to also end the Auth0 session. That redirects
 * to the tenant's `/v2/logout` endpoint, which clears the tenant session and
 * then sends the browser to `returnTo`. Note the requirement: the `returnTo`
 * value (PUBLIC_BASE_URL plus a trailing slash) must be listed in the
 * application's Allowed Logout URLs in the Auth0 dashboard, or Auth0 refuses
 * the redirect and the user lands on an Auth0 error page instead of the site.
 * That is why it is opt-in rather than the default — it needs tenant
 * configuration this repository cannot make on its own.
 *
 * Either way the local cookie is cleared first and unconditionally, so a
 * misconfigured or unreachable Auth0 tenant can never leave the user still
 * logged in here.
 */
import { auth0ConfigFromEnv } from '../../../src/core/auth0-verify.js';
import { buildLogoutUrl, STATE_COOKIE, VERIFIER_COOKIE } from '../../../src/core/auth0-login.js';
import { SESSION_COOKIE } from '../../../src/core/session.js';
import { publicBaseUrl } from '../../../src/core/public-base-url.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const base = publicBaseUrl();

  let location = '/';
  if (process.env.AUTH0_LOGOUT_REDIRECT === '1') {
    const config = auth0ConfigFromEnv(process.env);
    const clientId = process.env.AUTH0_CLIENT_ID;
    // Missing config is not an error worth showing anyone: the local cookie is
    // cleared regardless, so just fall back to the plain redirect.
    if (config && clientId) {
      location = buildLogoutUrl(config.issuer, clientId, `${base}/`);
    }
  }

  const headers = new Headers({ location, 'cache-control': 'no-store' });
  // Clear all three. The transient pair are normally gone already, but a login
  // abandoned midway can leave them behind.
  headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  headers.append('set-cookie', clearCookie(STATE_COOKIE));
  headers.append('set-cookie', clearCookie(VERIFIER_COOKIE));

  return new Response(null, { status: 303, headers });
}

/**
 * Must mirror the attributes the cookie was set with — browsers match a
 * deletion by name, path and domain, so a mismatched Path would silently leave
 * the real cookie in place and the user still signed in.
 */
function clearCookie(name: string): string {
  return `${name}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
