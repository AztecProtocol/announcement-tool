import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { assertPublishersConfigured } from '../src/core/identity.js';
import type { GuardEnv } from '../src/core/production-guard.js';

const PROD: GuardEnv = {
  deployTarget: 'netlify', publicBaseUrl: 'https://announce.aztec.network',
  auth0Issuer: 'https://x.example/', auth0Audience: 'a', auth0ClientSecret: 's',
  sessionSecret: 'x'.repeat(32), enabledChannels: 'webhook',
};
const DEV: GuardEnv = { ...PROD, allowInsecureDev: '1' };

const stub = (impl: () => Promise<unknown>) => ((..._a: unknown[]) => impl()) as unknown as Sql;
const err = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => { vi.restoreAllMocks(); });

describe('assertPublishersConfigured (start check)', () => {
  it('returns ok when the table has a publisher', async () => {
    expect(await assertPublishersConfigured(stub(async () => [{ c: 2 }]), PROD)).toBe('ok');
  });

  it('throws the refusal when the table is reachable and empty', async () => {
    await expect(assertPublishersConfigured(stub(async () => [{ c: 0 }]), PROD))
      .rejects.toThrow(/publishers table is empty/);
  });

  it.each(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNREFUSED',
    'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '53300'])(
    'treats %s as unreachable and does not throw', async (code) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await assertPublishersConfigured(stub(async () => { throw err(code); }), PROD)).toBe('unreachable');
      expect(spy).toHaveBeenCalledTimes(1);
      const msg = String(spy.mock.calls[0]![0]);
      expect(msg).toContain('unreachable');
      expect(msg).toContain(code);
    });

  it('treats a query that never answers as unreachable after the budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    expect(await assertPublishersConfigured(stub(() => new Promise(() => {})), PROD, { budgetMs: 100 })).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it.each(['28P01', '42P01', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])(
    'rethrows %s: a misconfiguration stays loud', async (code) => {
      await expect(assertPublishersConfigured(stub(async () => { throw err(code); }), PROD))
        .rejects.toMatchObject({ code });
    });

  it('rethrows an error with no code', async () => {
    await expect(assertPublishersConfigured(stub(async () => { throw new Error('boom'); }), PROD))
      .rejects.toThrow('boom');
  });

  it('skips the query entirely in insecure local development', async () => {
    const spy = vi.fn(async () => [{ c: 0 }]);
    expect(await assertPublishersConfigured(stub(spy), DEV)).toBe('ok');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([[[]], [[{}]], [[{ c: '3' }]], [[{ c: null }]], [[{ c: -1 }]], [[{ c: NaN }]]])(
    'refuses a malformed count answer %j instead of calling it ok', async (rows) => {
      await expect(assertPublishersConfigured(stub(async () => rows), PROD))
        .rejects.toThrow('start check: unexpected answer from the publishers count query');
    });

  it('logs an error that arrives after the budget fired, with its code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const slow = stub(() => new Promise((_, rej) => setTimeout(() => rej(err('28P01')), 150)));
    expect(await assertPublishersConfigured(slow, PROD, { budgetMs: 50 })).toBe('unreachable');
    await new Promise(r => setTimeout(r, 300));
    const msgs = spy.mock.calls.map(c => String(c[0]));
    expect(msgs).toContain('start check: the database answered late with an error (28P01)');

    spy.mockClear();
    const slowNoCode = stub(() => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), 150)));
    expect(await assertPublishersConfigured(slowNoCode, PROD, { budgetMs: 50 })).toBe('unreachable');
    await new Promise(r => setTimeout(r, 300));
    expect(spy.mock.calls.map(c => String(c[0]))).toContain('start check: the database answered late with an error (no code)');
  });

  it('an error inside the budget is reported once, by the awaited race only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await assertPublishersConfigured(stub(async () => { throw err('ECONNREFUSED'); }), PROD)).toBe('unreachable');
    await new Promise(r => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).not.toContain('answered late');
  });

  it('a late rejection after the budget fired does not become an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const on = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', on);
    try {
      const slow = stub(() => new Promise((_, rej) => setTimeout(() => rej(err('CONNECT_TIMEOUT')), 150)));
      expect(await assertPublishersConfigured(slow, PROD, { budgetMs: 50 })).toBe('unreachable');
      await new Promise(r => setTimeout(r, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });
});
