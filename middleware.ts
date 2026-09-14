/**
 * ⚠️ THIS FILE IS THE TRUST BOUNDARY FOR ADMIN IDENTITY. READ BEFORE EDITING. ⚠️
 *
 * On Netlify there is no authenticating proxy in front of this app. The Netlify
 * Auth0 extension only provisions environment variables (AUTH0_DOMAIN,
 * AUTH0_CLIENT_ID, AUTH0_AUDIENCE, AUTH0_ISSUER) — it sets NO user header and
 * terminates NO authentication. The documented pattern is that the client sends an
 * RS256 JWT in `Authorization: Bearer` and the application verifies it itself.
 * That is what happens here.
 *
 * Because `resolveIdentity` is synchronous and RS256 verification needs an async
 * JWKS fetch, verification cannot live inside it. Instead this middleware verifies
 * the token and hands the result to the app through an internal request header;
 * `resolveIdentity` then just reads that header and stays synchronous, leaving all
 * 17 of its call sites untouched.
 *
 * TWO sources can mint that header, tried in this order:
 *
 *   1. An `Authorization: Bearer` RS256 token, verified against the tenant JWKS.
 *      This is the API/script path and the one the deployment guide's security
 *      check exercises. It must keep working.
 *   2. The `announce_session` cookie, signed HS256 by app/admin/callback/route.ts
 *      after a completed browser login. This exists because a browser tab cannot
 *      attach an Authorization header to an ordinary navigation.
 *
 * The cookie is tried ONLY when the bearer path yielded no identity, so a request
 * carrying both cannot have a weaker credential override a stronger one. Both
 * sources are checked AFTER the strip below, never before it.
 *
 * The header is unsigned, so the entire four-eyes guarantee rests on the ORDER of
 * operations below. Specifically on step 1: the inbound copies of every identity
 * header — the internal Auth0 one and the VM's Tailscale pair — are deleted first
 * and unconditionally. Anyone who reaches this origin directly will try to set that
 * header themselves; if the delete is removed, made conditional, or moved below an
 * early return, admin identity becomes forgeable and a single person can
 * self-approve a `critical` announcement — an IRREVERSIBLE Discord role ping.
 *
 * Everything here fails CLOSED: any missing env var, missing token, verification
 * error, network failure, or unverified claim results in NO header being set, so
 * `resolveIdentity` returns undefined and app/admin/layout.tsx denies access.
 */
// Deep imports, not `next/server`. The public specifier does not type-check under
// TS7/NodeNext (next@16.2.12 ships no "exports" map), and mapping it in tsconfig
// `paths` would point the RUNTIME import at a .d.ts with no exports — making
// `NextResponse.next` compile to `(void 0)` under Turbopack. These are the modules
// `next/server` itself re-exports. Same treatment as app/admin/layout.tsx; the full
// reasoning is in tsconfig.json's paths comment.
import { NextResponse } from 'next/dist/server/web/spec-extension/response.js';
import type { NextRequest } from 'next/dist/server/web/spec-extension/request.js';
import { emailFromClaims, AUTH0_IDENTITY_HEADER } from './src/core/auth0-claims.js';
// Issuer normalisation, the per-process JWKS cache, and the `jwtVerify` call all
// live in ONE module, shared with app/admin/callback/route.ts. This file used to
// carry its own copy. Two copies of the logic four-eyes rests on WILL drift, and
// the drift is invisible at both call sites — the weaker copy silently becomes
// the way in. Do not reintroduce a private copy here.
import { auth0ConfigFromEnv, verifyAuth0Token } from './src/core/auth0-verify.js';
import { SESSION_COOKIE, verifySession } from './src/core/session.js';
import { buildCsp, cspHeaderName, generateNonce } from './src/web/csp.js';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // ── STEP 1 — STRIP. FIRST. UNCONDITIONAL. ─────────────────────────────────
  // Do not add any branch, early return, or `if` above these lines. This is what
  // makes an unsigned identity header safe to trust.
  const headers = new Headers(request.headers);
  headers.delete(AUTH0_IDENTITY_HEADER);
  // Defence in depth. `resolveIdentity` only reads these when DEPLOY_TARGET is
  // 'vm', and this middleware runs on Netlify where that is never the case — so
  // an inbound copy here can only be attacker-supplied. The real headers are
  // injected by `tailscale serve`, which is not in front of a Netlify
  // deployment; Netlify itself strips only its own `X-Nf-*` headers and forwards
  // everything else untouched. Stripping them means a future change that
  // weakens the DEPLOY_TARGET gate does not immediately reopen the hole.
  headers.delete('Tailscale-User-Login');
  headers.delete('Tailscale-User-Name');

  // From here on, `headers` is guaranteed free of any client-supplied identity.
  // Every failure path below simply forwards it unchanged, which denies access.

  // ── STEP 1b — CSP: one nonce per request ──────────────────────────────────
  // The nonce goes on the REQUEST headers because that is how Next learns it:
  // Next reads the `Content-Security-Policy` request header, pulls the
  // `'nonce-...'` value out of its script-src, and stamps that value onto every
  // script tag it emits. It also goes on the RESPONSE, under the header name
  // CSP_MODE selects — `Content-Security-Policy` only when CSP_MODE is exactly
  // `enforce`, otherwise `Content-Security-Policy-Report-Only`. The REQUEST
  // header keeps its own name in both modes; renaming it there would stop Next
  // finding the nonce and leave every script unstamped.
  //
  // This runs on every matched route, admin or not, so the whole site gets the
  // policy. It sits below the strip above and adds no branch of its own.
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const respond = (): NextResponse => {
    const response = NextResponse.next({ request: { headers } });
    response.headers.set(cspHeaderName(process.env.CSP_MODE), csp);
    return response;
  };

  // ── STEP 1c — everything that is not the admin surface stops here ─────────
  // The matcher covers the whole site so the strip above runs everywhere, but
  // identity is only ever consumed under /admin. This early return is what keeps
  // `bearerIdentity` and `sessionIdentity` off every public request: there is no
  // other path to them below. The comparison is exact — a prefix test alone
  // would also match a future sibling route such as `/administrative-notes`.
  const { pathname } = request.nextUrl;
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!isAdmin) return respond();

  // ── STEP 2 — bearer token, unchanged ──────────────────────────────────────
  // Tried first and left exactly as it has always behaved. The deployment
  // guide's security check drives this path; it must keep working.
  const email = (await bearerIdentity(request)) ?? (await sessionIdentity(request));

  // ── STEP 4 — set the internal header on the forwarded request ─────────────
  // Only reached when one of the two sources fully succeeded. Every other route
  // out of this function forwards the stripped headers via `respond()`.
  if (!email) return respond();
  headers.set(AUTH0_IDENTITY_HEADER, email);
  return respond();
}

/**
 * The `Authorization: Bearer` path. Returns the verified email, or `undefined`
 * on a missing/malformed header, missing configuration, a failed verification,
 * or a claim set that does not carry a verified email.
 *
 * Missing config returns undefined. It must NEVER mean "skip the check and trust
 * the token".
 */
async function bearerIdentity(request: NextRequest): Promise<string | undefined> {
  const authorization = request.headers.get('authorization');
  if (!authorization) return undefined;

  const match = /^Bearer (.+)$/i.exec(authorization.trim());
  if (!match) return undefined;
  const token = match[1].trim();
  if (!token) return undefined;

  const config = auth0ConfigFromEnv(process.env);
  if (!config) return undefined;

  // Verifies the RS256 signature against the tenant JWKS AND enforces `iss`,
  // `aud`, `exp` and `nbf` — checking the signature alone would accept a token
  // minted for a different application in the same tenant.
  const payload = await verifyAuth0Token(token, config);
  if (!payload) return undefined;

  return emailFromClaims(payload);
}

/**
 * ── STEP 3 — the session cookie, only when the bearer path found nothing ────
 *
 * Reached only as a fallback, so a request presenting both credentials is
 * decided by the bearer token and a cookie can never override it.
 *
 * `SESSION_SECRET` comes from the environment. When it is absent this returns
 * `undefined` — the cookie is NOT trusted unverified. A deployment that forgets
 * the secret gets nobody logged in, which is the correct failure direction:
 * trusting an unverified cookie would make admin identity, and therefore
 * four-eyes, forgeable by anyone who can set a cookie.
 *
 * `verifySession` checks the HS256 signature and expiry and returns `undefined`
 * on ANY failure without throwing, so a forged cookie is a clean denial.
 */
async function sessionIdentity(request: NextRequest): Promise<string | undefined> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return undefined;

  const value = request.cookies.get(SESSION_COOKIE)?.value;
  if (!value) return undefined;

  return verifySession(value, secret);
}

export const config = {
  // The whole site, because the CSP has to reach every page. This is a WIDENING
  // of the former `/admin/:path*`, which is safe in the direction that matters:
  // the strip in step 1 now runs on every request instead of only admin ones.
  // NARROWING it is not safe, because any /admin route left unmatched would skip
  // that strip and accept a client-supplied identity header.
  //
  // Identity is still confined to /admin by the exact path test in step 1c, not
  // by this matcher.
  //
  // /admin/login, /admin/callback and /admin/logout are matched too, and that is
  // correct: they need the strip like everything else. They cannot be locked out
  // by it because this middleware NEVER redirects — every path ends in
  // `NextResponse.next`, with or without the identity header. Those three routes
  // never call `resolveIdentity`, so a request with no header passes straight
  // through to them and the login flow works while signed out. Do not add a
  // redirect-to-login here: /admin/login is under this matcher, so redirecting
  // unauthenticated requests would bounce it to itself forever.
  //
  // Exclusions: the build's own static output (`_next/static`, `_next/image`)
  // and `favicon.ico` carry no scripts and need no policy; `api/csp-report` is
  // excluded so a violation report never picks up a policy header of its own and
  // never touches the identity path. The `missing` block keeps Next's own
  // prefetch requests out, as Next's nonce guide does — a prefetched document
  // would otherwise be cached with one request's nonce and replayed under
  // another's policy.
  matcher: [{
    source: '/((?!_next/static|_next/image|favicon.ico|api/csp-report).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
};
