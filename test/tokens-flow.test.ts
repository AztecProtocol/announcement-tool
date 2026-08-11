import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { unsubscribeByToken, updateFiltersByToken } from '../src/core/tokens-flow.js';
import { createSubscription } from '../src/core/subscriptions.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => { await resetDb(sql); });
afterAll(async () => { await sql.end(); });

describe('token flows', () => {
  it('unsubscribes by token, audits without PII, is idempotent', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'bye@example.com' });
    expect(await unsubscribeByToken(sql, sub.unsubscribeToken)).toBe(true);
    const [{ c }] = await sql`select count(*)::int as c from subscriptions`;
    expect(c).toBe(0);
    const audit = await sql`select action, detail from audit_log where action = 'subscription_deleted'`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].detail)).not.toContain('bye@example.com');
    expect(await unsubscribeByToken(sql, sub.unsubscribeToken)).toBe(false); // second click: gone already
  });

  it('updates filters by token with the empty-array guard', async () => {
    const sub = await createSubscription(sql, { channel: 'email', endpoint: 'mng@example.com' });
    expect(await updateFiltersByToken(sql, sub.unsubscribeToken, { severities: ['critical'] })).toBe(true);
    const [row] = await sql`select filter_severities from subscriptions where id = ${sub.id}`;
    expect(row.filter_severities).toEqual(['critical']);
    await expect(updateFiltersByToken(sql, sub.unsubscribeToken, { types: [] })).rejects.toThrow(/types.*empty/);
    expect(await updateFiltersByToken(sql, 'f'.repeat(32), { severities: ['critical'] })).toBe(false);
  });
});
