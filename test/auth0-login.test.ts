import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  STATE_COOKIE, VERIFIER_COOKIE, CALLBACK_PATH, TRANSIENT_COOKIE_MAX_AGE,
  createCodeVerifier, deriveCodeChallenge, createState, stateMatches,
  buildAuthorizeUrl, buildLogoutUrl, tokenEndpoint, buildTokenRequestBody,
  idTokenFromResponse, loginErrorRedirect,
} from '../src/core/auth0-login.js';
import { normalizeIssuer, auth0ConfigFromEnv } from '../src/core/auth0-verify.js';

const ISSUER = 'https://tenant.eu.auth0.com/';
const CLIENT_ID = 'client-abc123';

describe('PKCE code verifier (RFC 7636 §4.1)', () => {
  it('matches the code-verifier grammar 43*128unreserved', () => {
    for (let i = 0; i < 50; i++) {
      const v = createCodeVerifier();
      expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    }
  });

  it('produces 43 characters from the recommended 32 octets', () => {
    expect(createCodeVerifier()).toHaveLength(43);
  });

  it('is different on every call', () => {
    const seen = new Set(Array.from({ length: 100 }, () => createCodeVerifier()));
    expect(seen.size).toBe(100);
  });
});

describe('PKCE code challenge (RFC 7636 §4.2)', () => {
  // Appendix B of RFC 7636 gives this exact verifier/challenge pair.
  it('reproduces the RFC 7636 Appendix B test vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is base64url with no padding and no base64-only characters', () => {
    for (let i = 0; i < 25; i++) {
      const challenge = deriveCodeChallenge(createCodeVerifier());
      expect(challenge).not.toContain('=');
      expect(challenge).not.toContain('+');
      expect(challenge).not.toContain('/');
      expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    }
  });

  it('equals BASE64URL(SHA256(ASCII(verifier)))', () => {
    const verifier = createCodeVerifier();
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('is deterministic for a given verifier but differs between verifiers', () => {
    const a = createCodeVerifier();
    expect(deriveCodeChallenge(a)).toBe(deriveCodeChallenge(a));
    expect(deriveCodeChallenge(a)).not.toBe(deriveCodeChallenge(createCodeVerifier()));
  });
});

describe('stateMatches — CSRF protection', () => {
  it('accepts an exact match', () => {
    const s = createState();
    expect(stateMatches(s, s)).toBe(true);
  });

  it('rejects a different value of the same length', () => {
    const a = 'a'.repeat(43);
    const b = `${'a'.repeat(42)}b`;
    expect(stateMatches(a, b)).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the guard must catch this first.
    expect(() => stateMatches('short', 'a-much-longer-value')).not.toThrow();
    expect(stateMatches('short', 'a-much-longer-value')).toBe(false);
  });

  it.each([
    ['missing cookie', undefined, 'abc'],
    ['missing query param', 'abc', null],
    ['both missing', undefined, null],
    ['empty cookie', '', 'abc'],
    ['empty query param', 'abc', ''],
    ['both empty', '', ''],
  ])('fails closed: %s', (_label, expected, presented) => {
    expect(stateMatches(expected as string | undefined, presented as string | null)).toBe(false);
  });

  it('generates a distinct state per request', () => {
    const seen = new Set(Array.from({ length: 100 }, () => createState()));
    expect(seen.size).toBe(100);
  });
});

describe('buildAuthorizeUrl', () => {
  const url = () => new URL(buildAuthorizeUrl({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: 'https://announce.example.org/admin/callback',
    state: 'state-value',
    codeChallenge: 'challenge-value',
  }));

  it('targets the tenant /authorize endpoint', () => {
    expect(url().origin).toBe('https://tenant.eu.auth0.com');
    expect(url().pathname).toBe('/authorize');
  });

  it.each([
    ['response_type', 'code'],
    ['client_id', CLIENT_ID],
    ['redirect_uri', 'https://announce.example.org/admin/callback'],
    ['scope', 'openid email'],
    ['state', 'state-value'],
    ['code_challenge', 'challenge-value'],
    ['code_challenge_method', 'S256'],
  ])('sets %s', (key, value) => {
    expect(url().searchParams.get(key)).toBe(value);
  });

  it('requests the email claims emailFromClaims depends on', () => {
    const scope = url().searchParams.get('scope')!.split(' ');
    expect(scope).toContain('openid');
    expect(scope).toContain('email');
  });

  it('never uses the plain PKCE method', () => {
    expect(url().searchParams.get('code_challenge_method')).not.toBe('plain');
  });

  it('omits audience — this authenticates a human, it does not call an API', () => {
    expect(url().searchParams.has('audience')).toBe(false);
  });

  it('percent-encodes the redirect URI rather than concatenating it', () => {
    const raw = buildAuthorizeUrl({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: 'https://announce.example.org/admin/callback?x=1&y=2',
      state: 'a b',
      codeChallenge: 'c',
    });
    expect(raw).toContain('redirect_uri=https%3A%2F%2Fannounce.example.org%2Fadmin%2Fcallback%3Fx%3D1%26y%3D2');
    expect(new URL(raw).searchParams.get('state')).toBe('a b');
  });

  it('tolerates an issuer with no trailing slash', () => {
    const built = new URL(buildAuthorizeUrl({
      issuer: 'https://tenant.eu.auth0.com',
      clientId: CLIENT_ID,
      redirectUri: 'https://x/admin/callback',
      state: 's',
      codeChallenge: 'c',
    }));
    expect(built.pathname).toBe('/authorize');
    expect(built.origin).toBe('https://tenant.eu.auth0.com');
  });
});

describe('tokenEndpoint', () => {
  it('is {issuer}oauth/token', () => {
    expect(tokenEndpoint(ISSUER)).toBe('https://tenant.eu.auth0.com/oauth/token');
  });

  it('tolerates a missing trailing slash', () => {
    expect(tokenEndpoint('https://tenant.eu.auth0.com')).toBe('https://tenant.eu.auth0.com/oauth/token');
  });
});

describe('buildTokenRequestBody', () => {
  const body = () => new URLSearchParams(buildTokenRequestBody({
    clientId: CLIENT_ID,
    clientSecret: 'super-secret',
    code: 'auth-code',
    codeVerifier: 'the-verifier',
    redirectUri: 'https://announce.example.org/admin/callback',
  }));

  it.each([
    ['grant_type', 'authorization_code'],
    ['client_id', CLIENT_ID],
    ['client_secret', 'super-secret'],
    ['code', 'auth-code'],
    ['code_verifier', 'the-verifier'],
    ['redirect_uri', 'https://announce.example.org/admin/callback'],
  ])('sets %s', (key, value) => {
    expect(body().get(key)).toBe(value);
  });

  it('sends the PKCE verifier, without which the exchange is not PKCE at all', () => {
    expect(body().get('code_verifier')).toBe('the-verifier');
  });

  it('is form-encoded, not JSON', () => {
    const raw = buildTokenRequestBody({
      clientId: 'a', clientSecret: 'b', code: 'c', codeVerifier: 'd', redirectUri: 'e',
    });
    expect(raw).toContain('grant_type=authorization_code');
    expect(() => JSON.parse(raw)).toThrow();
  });
});

describe('idTokenFromResponse', () => {
  it('reads a well-formed token response', () => {
    expect(idTokenFromResponse({
      access_token: 'a', id_token: 'the.id.token', token_type: 'Bearer', expires_in: 86400,
    })).toBe('the.id.token');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'id_token'],
    ['a number', 7],
    ['an object with no id_token', { access_token: 'a' }],
    ['a non-string id_token', { id_token: 12345 }],
    ['a null id_token', { id_token: null }],
    ['an empty id_token', { id_token: '' }],
    ['a whitespace id_token', { id_token: '   ' }],
    ['an Auth0 error body', { error: 'invalid_grant', error_description: 'boom' }],
  ])('returns undefined for %s', (_label, input) => {
    expect(idTokenFromResponse(input)).toBeUndefined();
  });
});

describe('buildLogoutUrl', () => {
  it('uses /v2/logout with the camelCase returnTo parameter', () => {
    const url = new URL(buildLogoutUrl(ISSUER, CLIENT_ID, 'https://announce.example.org/'));
    expect(url.pathname).toBe('/v2/logout');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('returnTo')).toBe('https://announce.example.org/');
    // The /oidc/logout spelling would be silently ignored by /v2/logout.
    expect(url.searchParams.has('post_logout_redirect_uri')).toBe(false);
  });
});

describe('loginErrorRedirect', () => {
  it('points at /admin with an opaque slug', () => {
    expect(loginErrorRedirect('state')).toBe('/admin?login_error=state');
  });

  it.each(['config', 'state', 'provider', 'exchange', 'token', 'identity'] as const)(
    'produces a safe relative URL for %s',
    (slug) => {
      const target = loginErrorRedirect(slug);
      expect(target.startsWith('/admin?')).toBe(true);
      // Must not be protocol-relative or absolute — that would be an open redirect.
      expect(target.startsWith('//')).toBe(false);
      expect(/^[a-z]+:/.test(target)).toBe(false);
    },
  );
});

describe('cookie and path constants', () => {
  it('names the transient cookies distinctly from the session cookie', () => {
    expect(STATE_COOKIE).toBe('announce_oauth_state');
    expect(VERIFIER_COOKIE).toBe('announce_oauth_verifier');
    expect(STATE_COOKIE).not.toBe(VERIFIER_COOKIE);
  });

  it('keeps the transient cookies short-lived', () => {
    expect(TRANSIENT_COOKIE_MAX_AGE).toBe(600);
  });

  it('routes the callback under /admin so the middleware matcher covers it', () => {
    expect(CALLBACK_PATH).toBe('/admin/callback');
    expect(CALLBACK_PATH.startsWith('/admin/')).toBe(true);
  });
});

describe('auth0-verify shared helpers', () => {
  it('normalises an issuer with and without a trailing slash', () => {
    expect(normalizeIssuer('https://t.auth0.com')).toBe('https://t.auth0.com/');
    expect(normalizeIssuer('https://t.auth0.com/')).toBe('https://t.auth0.com/');
  });

  it('prefers AUTH0_ISSUER and AUTH0_AUDIENCE when set', () => {
    expect(auth0ConfigFromEnv({
      AUTH0_ISSUER: 'https://explicit.auth0.com/',
      AUTH0_DOMAIN: 'derived.auth0.com',
      AUTH0_AUDIENCE: 'explicit-aud',
      AUTH0_CLIENT_ID: 'client-id',
    })).toEqual({ issuer: 'https://explicit.auth0.com/', audience: 'explicit-aud' });
  });

  it('derives the issuer from AUTH0_DOMAIN and the audience from AUTH0_CLIENT_ID', () => {
    expect(auth0ConfigFromEnv({
      AUTH0_DOMAIN: 'derived.auth0.com',
      AUTH0_CLIENT_ID: 'client-id',
    })).toEqual({ issuer: 'https://derived.auth0.com/', audience: 'client-id' });
  });

  it('normalises an AUTH0_ISSUER that is missing its trailing slash', () => {
    expect(auth0ConfigFromEnv({
      AUTH0_ISSUER: 'https://noslash.auth0.com',
      AUTH0_AUDIENCE: 'aud',
    })?.issuer).toBe('https://noslash.auth0.com/');
  });

  it.each([
    ['no issuer source', { AUTH0_AUDIENCE: 'aud' }],
    ['no audience source', { AUTH0_DOMAIN: 'd.auth0.com' }],
    ['nothing at all', {}],
  ])('fails closed with %s — missing config must never mean "skip the check"', (_label, env) => {
    expect(auth0ConfigFromEnv(env)).toBeUndefined();
  });
});
