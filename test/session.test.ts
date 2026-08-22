import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, signSession, verifySession } from '../src/core/session.js';

const SECRET = 'test-secret-at-least-32-bytes-long-aaaaaa';
const OTHER_SECRET = 'a-completely-different-secret-bbbbbbbbbbbb';

describe('SESSION_COOKIE', () => {
  it('is the fixed cookie name', () => {
    expect(SESSION_COOKIE).toBe('announce_session');
  });
});

describe('signSession / verifySession round-trip', () => {
  it('verifies to the same email that was signed', async () => {
    const token = await signSession('publisher@example.com', SECRET);
    await expect(verifySession(token, SECRET)).resolves.toBe('publisher@example.com');
  });
});

describe('verifySession failure modes', () => {
  it('denies a tampered payload', async () => {
    const token = await signSession('publisher@example.com', SECRET);
    const parts = token.split('.');
    // Flip the payload segment so the signature no longer matches.
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'attacker@example.com', exp: 9999999999 }))
      .toString('base64url');
    const tampered = [parts[0], tamperedPayload, parts[2]].join('.');
    await expect(verifySession(tampered, SECRET)).resolves.toBeUndefined();
  });

  it('denies a token signed with a different secret', async () => {
    const token = await signSession('publisher@example.com', OTHER_SECRET);
    await expect(verifySession(token, SECRET)).resolves.toBeUndefined();
  });

  it('denies an expired token', async () => {
    const token = await signSession('publisher@example.com', SECRET, -1);
    await expect(verifySession(token, SECRET)).resolves.toBeUndefined();
  });

  it.each(['', 'abc', 'a.b.c'])('denies garbage input %j without throwing', async (garbage) => {
    await expect(verifySession(garbage, SECRET)).resolves.toBeUndefined();
  });
});

describe('empty/whitespace email rejection', () => {
  it('rejects signing an empty email', async () => {
    await expect(signSession('', SECRET)).rejects.toThrow();
  });

  it('rejects signing a whitespace-only email', async () => {
    await expect(signSession('   ', SECRET)).rejects.toThrow();
  });
});
