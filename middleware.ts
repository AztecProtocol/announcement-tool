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
 * The header is unsigned, so the entire four-eyes guarantee rests on the ORDER of
 * operations below. Specifically on step 1: the inbound copy is deleted first and
 * unconditionally. Anyone who reaches this origin directly will try to set that
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
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { emailFromClaims, AUTH0_IDENTITY_HEADER } from './src/core/auth0-claims.js';

/**
 * `createRemoteJWKSet` caches the fetched key set and handles rotation, so it must
 * be created once per process, not per request. Built lazily because the env vars
 * are absent in local dev and on the VM deployment, where this path never runs.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer));
    jwksIssuer = issuer;
  }
  return jwks;
}

/** Auth0 sets AUTH0_ISSUER with a trailing slash; tolerate it missing either way. */
function normalizeIssuer(raw: string): string {
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // ── STEP 1 — STRIP. FIRST. UNCONDITIONAL. ─────────────────────────────────
  // Do not add any branch, early return, or `if` above this line. This is the
  // single line that makes an unsigned identity header safe to trust.
  const headers = new Headers(request.headers);
  headers.delete(AUTH0_IDENTITY_HEADER);

  // From here on, `headers` is guaranteed free of any client-supplied identity.
  // Every failure path below simply forwards it unchanged, which denies access.
  const deny = () => NextResponse.next({ request: { headers } });

  // ── STEP 2 — read the bearer token ────────────────────────────────────────
  const authorization = request.headers.get('authorization');
  if (!authorization) return deny();

  const match = /^Bearer (.+)$/i.exec(authorization.trim());
  if (!match) return deny();
  const token = match[1].trim();
  if (!token) return deny();

  // Config is required for verification. Missing config must NOT mean "skip the
  // check and trust the token" — it means deny.
  const issuerRaw = process.env.AUTH0_ISSUER ?? (
    process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}/` : undefined
  );
  const audience = process.env.AUTH0_AUDIENCE ?? process.env.AUTH0_CLIENT_ID;
  if (!issuerRaw || !audience) return deny();

  const issuer = normalizeIssuer(issuerRaw);

  // ── STEP 3 — verify signature, issuer, audience and expiry ────────────────
  // `jwtVerify` checks the RS256 signature against the JWKS AND enforces `iss`,
  // `aud`, `exp` and `nbf`. Checking the signature alone would accept a valid
  // token minted for a different application in the same tenant.
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    // Bad signature, wrong issuer/audience, expired, or JWKS fetch failure.
    // All of them deny. The reason is deliberately not echoed to the client.
    return deny();
  }

  // ── STEP 4 — apply the claim policy ───────────────────────────────────────
  const email = emailFromClaims(payload);
  if (!email) return deny();

  // ── STEP 5 — set the internal header on the forwarded request ─────────────
  // Only reached on full success: verified signature, matching issuer and
  // audience, unexpired, and a verified email claim.
  headers.set(AUTH0_IDENTITY_HEADER, email);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Scoped to the admin surface — the only place identity is consumed. Widening
  // this is safe; NARROWING it is not, because any /admin route left unmatched
  // would skip the strip in step 1 and accept a client-supplied identity header.
  matcher: ['/admin/:path*'],
};
