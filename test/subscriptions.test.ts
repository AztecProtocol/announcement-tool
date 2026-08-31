import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { createSubscription, verifySubscription, getSubscription, matchesSubscription, getSubscriptionByVerifyToken } from '../src/core/subscriptions.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const annCritMain = { type: 'upgrade' as const, severity: 'critical' as const, networks: ['mainnet' as const], audiences: ['operators' as const] };

describe('subscriptions', () => {
  it('creates an unverified webhook subscription with a secret, then verifies it', async () => {
    const s = await createSubscription(sql, { channel: 'webhook', endpoint: 'https://ops.example.com/hook' });
    expect(s.verified).toBe(false);
    expect(s.secret).toMatch(/^whsec_/);
    await verifySubscription(sql, s.id);
    expect((await getSubscription(sql, s.id))!.verified).toBe(true);
  });

  it('email subscriptions have no secret', async () => {
    const s = await createSubscription(sql, { channel: 'email', endpoint: 'ops@example.com' });
    expect(s.secret).toBeUndefined();
  });

  it('rejects duplicate channel+endpoint', async () => {
    await createSubscription(sql, { channel: 'email', endpoint: 'ops@example.com' });
    await expect(createSubscription(sql, { channel: 'email', endpoint: 'ops@example.com' }))
      .rejects.toThrow(/duplicate key/);
  });

  it('matches only when every filter dimension intersects', async () => {
    const s = await createSubscription(sql, {
      channel: 'email', endpoint: 'a@x.com',
      filters: { networks: ['mainnet'], types: ['upgrade', 'governance'], severities: ['critical'], audiences: ['operators'] },
    });
    expect(matchesSubscription(annCritMain, s)).toBe(true);
    expect(matchesSubscription({ ...annCritMain, networks: ['testnet'] }, s)).toBe(false);
    expect(matchesSubscription({ ...annCritMain, severity: 'recommended' }, s)).toBe(false);
    expect(matchesSubscription({ ...annCritMain, type: 'info' }, s)).toBe(false);
    expect(matchesSubscription({ ...annCritMain, audiences: ['ecosystem'] }, s)).toBe(false);
    // announcement targeting both networks still reaches a mainnet-only subscriber
    expect(matchesSubscription({ ...annCritMain, networks: ['mainnet', 'testnet'] }, s)).toBe(true);
  });

  it('rejects empty filter arrays', async () => {
    await expect(createSubscription(sql, {
      channel: 'email', endpoint: 'empty@example.com', filters: { severities: [] },
    })).rejects.toThrow(/severities.*empty/);
  });

  it('every subscription carries a unique verify token, findable by it', async () => {
    const s = await createSubscription(sql, { channel: 'email', endpoint: 'vt@example.com' });
    expect(s.verifyToken).toMatch(/^[0-9a-f]{32}$/);
    const found = await getSubscriptionByVerifyToken(sql, s.verifyToken);
    expect(found?.id).toBe(s.id);
    expect(await getSubscriptionByVerifyToken(sql, 'f'.repeat(32))).toBeUndefined();
  });
});
