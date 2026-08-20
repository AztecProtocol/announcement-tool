import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { resolveIdentity, isPublisher, listPublishers, assertPublishersConfigured } from '../src/core/identity.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); await sql`delete from publishers`; });
afterAll(async () => { await sql.end(); });

describe('resolveIdentity', () => {
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
