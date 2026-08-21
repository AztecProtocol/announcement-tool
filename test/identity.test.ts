import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { resolveIdentity, isPublisher, listPublishers, assertPublishersConfigured } from '../src/core/identity.js';
import { AUTH0_IDENTITY_HEADER } from '../src/core/auth0-claims.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); await sql`delete from publishers`; });
afterAll(async () => { await sql.end(); });

describe('resolveIdentity', () => {
  // resolveIdentity reads process.env.DEPLOY_TARGET directly (it must stay
  // synchronous — 17 call sites). Mutating process.env leaks between cases, so
  // save and restore it around every one rather than letting the suite become
  // order-dependent.
  const savedDeployTarget = process.env.DEPLOY_TARGET;
  beforeEach(() => { process.env.DEPLOY_TARGET = 'vm'; });
  afterEach(() => {
    if (savedDeployTarget === undefined) delete process.env.DEPLOY_TARGET;
    else process.env.DEPLOY_TARGET = savedDeployTarget;
  });

  it('prefers the verified Auth0 header over every other source', () => {
    const h = new Headers({
      [AUTH0_IDENTITY_HEADER]: 'publisher@example.com',
      'Tailscale-User-Login': 'someone.else@aztecprotocol.com',
    });
    expect(resolveIdentity(h, { devEmail: 'dev@example.com' }))
      .toEqual({ email: 'publisher@example.com', source: 'auth0' });
  });

  it('trims the Auth0 header and ignores it when blank', () => {
    expect(resolveIdentity(new Headers({ [AUTH0_IDENTITY_HEADER]: '  publisher@example.com ' }), {}))
      .toEqual({ email: 'publisher@example.com', source: 'auth0' });
    // A blank value must fall through rather than resolve to an empty identity.
    expect(resolveIdentity(new Headers({ [AUTH0_IDENTITY_HEADER]: '   ' }), {})).toBeUndefined();
  });

  it('falls through to Tailscale when no Auth0 header is present', () => {
    const h = new Headers({ 'Tailscale-User-Login': 'publisher@example.com' });
    expect(resolveIdentity(h, {}))
      .toEqual({ email: 'publisher@example.com', source: 'tailscale' });
  });

  it('prefers the Tailscale header', () => {
    const h = new Headers({ 'Tailscale-User-Login': 'publisher@example.com', 'Tailscale-User-Name': 'Publisher' });
    expect(resolveIdentity(h, { devEmail: 'dev@example.com' }))
      .toEqual({ email: 'publisher@example.com', name: 'Publisher', source: 'tailscale' });
  });

  it('falls back to the dev email only when no header is present', () => {
    expect(resolveIdentity(new Headers(), { devEmail: 'dev@example.com' }))
      .toEqual({ email: 'dev@example.com', source: 'dev' });
  });

  it('returns undefined with neither', () => {
    expect(resolveIdentity(new Headers(), {})).toBeUndefined();
  });

  // ── The Tailscale branch is gated on the deployment shape ──────────────────
  // On Netlify the app is reachable from the public internet and Netlify strips
  // only its own X-Nf-* headers, so an inbound Tailscale-User-Login can ONLY be
  // attacker-supplied. Honouring it would let one person request a `critical`
  // announcement under one address and confirm it under another, collapsing
  // four-eyes and firing an irreversible Discord role ping.
  describe('deployment gating of the Tailscale header', () => {
    it('IGNORES the Tailscale header entirely on DEPLOY_TARGET=netlify', () => {
      process.env.DEPLOY_TARGET = 'netlify';
      const h = new Headers({
        'Tailscale-User-Login': 'attacker@aztecprotocol.com',
        'Tailscale-User-Name': 'Not Me',
      });
      expect(resolveIdentity(h, {})).toBeUndefined();
    });

    it('does not let a forged Tailscale header become the dev identity on netlify', () => {
      process.env.DEPLOY_TARGET = 'netlify';
      const h = new Headers({ 'Tailscale-User-Login': 'attacker@aztecprotocol.com' });
      // It must fall THROUGH to the dev fallback, never resolve as tailscale.
      expect(resolveIdentity(h, { devEmail: 'dev@example.com' }))
        .toEqual({ email: 'dev@example.com', source: 'dev' });
    });

    it('still honours the Tailscale header on DEPLOY_TARGET=vm — the VM must keep working', () => {
      process.env.DEPLOY_TARGET = 'vm';
      const h = new Headers({ 'Tailscale-User-Login': 'publisher@example.com', 'Tailscale-User-Name': 'Publisher' });
      expect(resolveIdentity(h, {}))
        .toEqual({ email: 'publisher@example.com', name: 'Publisher', source: 'tailscale' });
    });

    it('IGNORES the Tailscale header when DEPLOY_TARGET is unset — the gate is an allowlist', () => {
      // Chosen deliberately: an unset value must LOSE an identity source, never
      // gain one, so a Netlify box that forgot the runtime variable is not
      // silently exploitable. Nothing legitimate is stranded — production-guard
      // already refuses to boot on an unset DEPLOY_TARGET.
      delete process.env.DEPLOY_TARGET;
      const h = new Headers({ 'Tailscale-User-Login': 'attacker@aztecprotocol.com' });
      expect(resolveIdentity(h, {})).toBeUndefined();
    });

    it('IGNORES the Tailscale header on an unrecognized DEPLOY_TARGET', () => {
      process.env.DEPLOY_TARGET = 'VM';  // wrong case, and any future value
      const h = new Headers({ 'Tailscale-User-Login': 'attacker@aztecprotocol.com' });
      expect(resolveIdentity(h, {})).toBeUndefined();
    });

    it('keeps the verified Auth0 header authoritative on netlify, forged Tailscale header or not', () => {
      process.env.DEPLOY_TARGET = 'netlify';
      const h = new Headers({
        [AUTH0_IDENTITY_HEADER]: 'publisher@example.com',
        'Tailscale-User-Login': 'attacker@aztecprotocol.com',
      });
      expect(resolveIdentity(h, {}))
        .toEqual({ email: 'publisher@example.com', source: 'auth0' });
    });

    it('keeps the ADMIN_EMAIL dev fallback working for local development', () => {
      // Local dev sets ANNOUNCE_ALLOW_INSECURE_DEV=1 and ADMIN_EMAIL, and does
      // not necessarily set DEPLOY_TARGET at all. That path must be unaffected.
      delete process.env.DEPLOY_TARGET;
      const savedAdmin = process.env.ADMIN_EMAIL;
      process.env.ADMIN_EMAIL = 'local@example.com';
      try {
        expect(resolveIdentity(new Headers(), {}))
          .toEqual({ email: 'local@example.com', source: 'dev' });
      } finally {
        if (savedAdmin === undefined) delete process.env.ADMIN_EMAIL;
        else process.env.ADMIN_EMAIL = savedAdmin;
      }
    });
  });
});

describe('publishers', () => {
  it('bootstraps: an empty table means any identity may publish', async () => {
    expect(await isPublisher(sql, 'anyone@example.com')).toBe(true);
  });

  it('once populated, only listed emails may publish', async () => {
    await sql`insert into publishers (email) values ('publisher@example.com')`;
    expect(await isPublisher(sql, 'publisher@example.com')).toBe(true);
    expect(await isPublisher(sql, 'stranger@example.com')).toBe(false);
    expect(await listPublishers(sql)).toEqual(['publisher@example.com']);
  });
});

describe('assertPublishersConfigured', () => {
  it('passes when a publisher exists', async () => {
    await sql`insert into publishers (email) values ('alice@example.com')`;
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'production' })).resolves.toBeUndefined();
  });

  it('throws when the table is empty', async () => {
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'production' }))
      .rejects.toThrow(/publishers/i);
  });

  it('names the seed script in the message, so the fix is obvious', async () => {
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'production' }))
      .rejects.toThrow(/seed:publisher/);
  });

  it('still throws when nodeEnv is not "production" — the check does not key off NODE_ENV', async () => {
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'staging' })).rejects.toThrow(/publishers/i);
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'development' })).rejects.toThrow(/publishers/i);
    await expect(assertPublishersConfigured(sql, {})).rejects.toThrow(/publishers/i);
  });

  it('does nothing when ANNOUNCE_ALLOW_INSECURE_DEV=1 opts out, so local work is unaffected', async () => {
    await expect(assertPublishersConfigured(sql, { nodeEnv: 'development', allowInsecureDev: '1' }))
      .resolves.toBeUndefined();
    await expect(assertPublishersConfigured(sql, { allowInsecureDev: '1' })).resolves.toBeUndefined();
  });
});
