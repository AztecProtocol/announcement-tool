import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { consumeRateLimit, RATE_LIMITS } from '../src/core/rate-limit.js';
import { clientIpFromHeaders } from '../src/web/client-ip.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

const rule = { limit: 3, windowSeconds: 3600 };
// Pinned mid-window so the fixed window never rolls over during a test.
const now = new Date('2026-09-07T12:30:00.000Z');

describe('consumeRateLimit', () => {
  it('allows the first `limit` calls, counts down, then refuses with a positive retryAfterSeconds', async () => {
    const first = await consumeRateLimit(sql, 'email:ip:203.0.113.5', rule, now);
    expect(first).toMatchObject({ allowed: true, remaining: 2 });

    const second = await consumeRateLimit(sql, 'email:ip:203.0.113.5', rule, now);
    expect(second).toMatchObject({ allowed: true, remaining: 1 });

    const third = await consumeRateLimit(sql, 'email:ip:203.0.113.5', rule, now);
    expect(third).toMatchObject({ allowed: true, remaining: 0 });

    const fourth = await consumeRateLimit(sql, 'email:ip:203.0.113.5', rule, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    // Window ends at 13:00:00Z; `now` is 12:30:00Z.
    expect(fourth.retryAfterSeconds).toBe(1800);
  });

  it('allows again once `now` moves past the window', async () => {
    for (let i = 0; i < rule.limit; i++) await consumeRateLimit(sql, 'email:addr:a@x.com', rule, now);
    expect((await consumeRateLimit(sql, 'email:addr:a@x.com', rule, now)).allowed).toBe(false);

    const later = new Date(now.getTime() + rule.windowSeconds * 1000);
    const afterWindow = await consumeRateLimit(sql, 'email:addr:a@x.com', rule, later);
    expect(afterWindow).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('does not share a counter between two different keys', async () => {
    for (let i = 0; i < rule.limit; i++) await consumeRateLimit(sql, 'email:ip:198.51.100.1', rule, now);
    expect((await consumeRateLimit(sql, 'email:ip:198.51.100.1', rule, now)).allowed).toBe(false);

    const other = await consumeRateLimit(sql, 'email:ip:198.51.100.2', rule, now);
    expect(other).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('removes rows whose window is older than a day', async () => {
    const ancient = new Date(now.getTime() - 2 * 86_400_000);
    await sql`insert into rate_limits (key, window_start, count) values ('email:ip:stale', ${ancient}, 7)`;
    expect((await sql`select count(*)::int as n from rate_limits where key = 'email:ip:stale'`)[0].n).toBe(1);

    await consumeRateLimit(sql, 'email:ip:fresh', rule, now);

    expect((await sql`select count(*)::int as n from rate_limits where key = 'email:ip:stale'`)[0].n).toBe(0);
  });

  it('exposes the three configured limits', () => {
    expect(RATE_LIMITS.emailPerAddress).toEqual({ limit: 3, windowSeconds: 3600 });
    expect(RATE_LIMITS.emailPerIp).toEqual({ limit: 10, windowSeconds: 3600 });
    expect(RATE_LIMITS.webhookPerIp).toEqual({ limit: 5, windowSeconds: 3600 });
  });
});

describe('clientIpFromHeaders', () => {
  const headersOf = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });

  it('prefers the Netlify connection-ip header', () => {
    expect(clientIpFromHeaders(headersOf({
      'x-nf-client-connection-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.1',
    }))).toBe('203.0.113.9');
  });

  it('falls back to the first entry of x-forwarded-for', () => {
    expect(clientIpFromHeaders(headersOf({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
  });

  it('returns "unknown" when neither header is present', () => {
    expect(clientIpFromHeaders(headersOf({}))).toBe('unknown');
  });
});
