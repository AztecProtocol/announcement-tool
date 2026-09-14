/**
 * Locks the middleware's trust-boundary invariants in CI.
 *
 * `middleware.ts` is where admin identity is decided. Two properties keep it
 * safe, and neither was enforced by a test before: the inbound copies of every
 * identity header are stripped from EVERY request, and the matcher exempts
 * nothing on the basis of a request header. A review round found a matcher
 * `missing` block that let `curl -H 'purpose: prefetch'` skip the middleware
 * entirely and render /admin as a forged address. These tests exist so that
 * class of regression fails the build instead of shipping.
 *
 * The forwarded request headers are read back through Next's own wire format:
 * `NextResponse.next({ request: { headers } })` does not mutate the incoming
 * request, it encodes the replacement headers onto the RESPONSE as
 * `x-middleware-request-<name>` entries plus an `x-middleware-override-headers`
 * list. That is what the Next server reads downstream, so asserting on it is
 * asserting on exactly what the page will see.
 */
import { describe, expect, it, afterEach } from 'vitest';
// Same deep imports the middleware itself uses; see tsconfig.json's paths comment.
import { NextRequest } from 'next/dist/server/web/spec-extension/request.js';
import type { NextResponse } from 'next/dist/server/web/spec-extension/response.js';
import { middleware, config } from '../middleware.js';
import { AUTH0_IDENTITY_HEADER } from '../src/core/auth0-claims.js';

const FORGED_EMAIL = 'attacker@evil.com';

/** Reads back the request headers the middleware forwards to the page. */
function forwardedRequestHeaders(response: NextResponse): Headers {
  const forwarded = new Headers();
  const overridden = response.headers.get('x-middleware-override-headers');
  if (!overridden) return forwarded;
  for (const name of overridden.split(',')) {
    const key = name.trim();
    if (!key) continue;
    const value = response.headers.get(`x-middleware-request-${key}`);
    if (value !== null) forwarded.set(key, value);
  }
  return forwarded;
}

/** A request carrying both forged identity headers an attacker would try. */
function forgedRequest(path: string, extra: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://announce.aztec.network${path}`, {
    headers: {
      [AUTH0_IDENTITY_HEADER]: FORGED_EMAIL,
      'Tailscale-User-Login': FORGED_EMAIL,
      'Tailscale-User-Name': 'Attacker',
      ...extra,
    },
  });
}

const originalCspMode = process.env.CSP_MODE;
afterEach(() => {
  if (originalCspMode === undefined) delete process.env.CSP_MODE;
  else process.env.CSP_MODE = originalCspMode;
});

describe('middleware identity strip', () => {
  // (a) Public routes: the forged identity must never survive the middleware.
  for (const path of ['/', '/archive', '/docs/webhooks']) {
    it(`strips forged identity headers on ${path} and still sets the nonce`, async () => {
      const forwarded = forwardedRequestHeaders(await middleware(forgedRequest(path)));

      expect(forwarded.get(AUTH0_IDENTITY_HEADER)).toBeNull();
      expect(forwarded.get('tailscale-user-login')).toBeNull();
      expect(forwarded.get('tailscale-user-name')).toBeNull();

      expect(forwarded.get('x-nonce')).toBeTruthy();
      const csp = forwarded.get('content-security-policy');
      expect(csp).toContain(`'nonce-${forwarded.get('x-nonce')}'`);
    });
  }

  // (b) The admin route with no credential at all: same guarantee. This is the
  // path that actually consumes identity, so a leak here is the whole exposure.
  it('strips forged identity headers on /admin when no session and no bearer are present', async () => {
    const forwarded = forwardedRequestHeaders(await middleware(forgedRequest('/admin')));

    expect(forwarded.get(AUTH0_IDENTITY_HEADER)).toBeNull();
    expect(forwarded.get('tailscale-user-login')).toBeNull();
    expect(forwarded.get('tailscale-user-name')).toBeNull();
    expect(forwarded.get('x-nonce')).toBeTruthy();
  });

  // The specific regression this round found: a header an attacker controls
  // must not change the outcome. With the matcher fixed, Next runs the
  // middleware regardless; this asserts the middleware itself is indifferent.
  it('ignores a client-supplied prefetch header when stripping identity', async () => {
    const prefetchHeaders: Record<string, string>[] = [
      { purpose: 'prefetch' },
      { 'next-router-prefetch': '1' },
    ];
    for (const extra of prefetchHeaders) {
      const forwarded = forwardedRequestHeaders(await middleware(forgedRequest('/admin', extra)));
      expect(forwarded.get(AUTH0_IDENTITY_HEADER)).toBeNull();
      expect(forwarded.get('tailscale-user-login')).toBeNull();
    }
  });

  it('gives a different nonce to each request', async () => {
    const first = forwardedRequestHeaders(await middleware(forgedRequest('/'))).get('x-nonce');
    const second = forwardedRequestHeaders(await middleware(forgedRequest('/'))).get('x-nonce');
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe('middleware CSP response header', () => {
  // (c) The mode switch, read off the real response.
  it('sends Report-Only when CSP_MODE is unset', async () => {
    delete process.env.CSP_MODE;
    const response = await middleware(forgedRequest('/'));
    expect(response.headers.get('content-security-policy-report-only')).toContain('nonce-');
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('sends the enforcing header when CSP_MODE is exactly enforce', async () => {
    process.env.CSP_MODE = 'enforce';
    const response = await middleware(forgedRequest('/'));
    expect(response.headers.get('content-security-policy')).toContain('nonce-');
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('treats any other CSP_MODE value as report-only', async () => {
    process.env.CSP_MODE = 'Enforce';
    const response = await middleware(forgedRequest('/'));
    expect(response.headers.get('content-security-policy-report-only')).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});

describe('middleware matcher shape', () => {
  // (d) Structural guard. A matcher entry may exclude by PATH only. An object
  // entry can carry `missing`/`has` conditions keyed on request headers, and a
  // request header is set by whoever makes the request — so such a condition is
  // a client-controlled opt-out of the identity strip above, not an
  // optimisation. One shipped briefly and let a forged identity header through
  // to /admin behind `purpose: prefetch`.
  it('is an array of plain string patterns, never objects with missing/has conditions', () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    for (const entry of config.matcher) {
      expect(
        typeof entry,
        'middleware matcher entries must be strings. An object entry can carry `missing` or ' +
          '`has` conditions keyed on request headers, which lets a client exempt itself from ' +
          'the identity strip in middleware.ts by setting that header. Exclude by path instead.',
      ).toBe('string');
    }
  });

  it('still covers the admin surface and the site root', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ['/', '/admin', '/admin/review/abc', '/archive', '/docs/webhooks']) {
      expect(pattern.test(path), `${path} must be matched by the middleware`).toBe(true);
    }
  });

  it('excludes only build output, the favicon and the report endpoint', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ['/_next/static/chunk.js', '/_next/image', '/favicon.ico', '/api/csp-report']) {
      expect(pattern.test(path), `${path} must not be matched`).toBe(false);
    }
  });
});
