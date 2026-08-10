import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { testSql, resetDb } from './helpers.js';
import { runFanoutOnce, MAX_ATTEMPTS } from '../src/worker/fanout.js';
import type { ChannelAdapter } from '../src/adapters/types.js';

let sql: Sql;
beforeAll(async () => { sql = await testSql(); });
beforeEach(async () => {
  await resetDb(sql);
  await sql`insert into announcements (id, revision, slug, type, networks, audiences, severity, title, body_md, status, created_by)
    values ('ann_w', 1, 's', 'upgrade', '{mainnet}', '{operators}', 'critical', 't', 'b', 'published', 'a@x')`;
  await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
    values ('ann_w', 1, 'publish', 'webhook', 'sub_1')`;
});
afterAll(async () => { await sql.end(); });

const okAdapter = (calls: string[]): ChannelAdapter => ({
  channel: 'webhook',
  deliver: async (a, target) => { calls.push(`${a.id}:${target}`); },
});
const failAdapter: ChannelAdapter = {
  channel: 'webhook',
  deliver: async () => { throw new Error('endpoint down'); },
};

describe('runFanoutOnce', () => {
  it('delivers pending rows and marks them delivered', async () => {
    const calls: string[] = [];
    const res = await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(res).toEqual({ delivered: 1, failed: 0 });
    expect(calls).toEqual(['ann_w:sub_1']);
    const [row] = await sql`select status, attempts, delivered_at from delivery_ledger where target = 'sub_1'`;
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(1);
    expect(row.delivered_at).not.toBeNull();
  });

  it('is idempotent — a delivered row is never re-sent', async () => {
    const calls: string[] = [];
    await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(calls.length).toBe(1);
  });

  it('on failure: backoff scheduled, then exhausted after MAX_ATTEMPTS', async () => {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await sql`update delivery_ledger set next_attempt_at = now() where target = 'sub_1'`;
      const res = await runFanoutOnce(sql, { webhook: failAdapter });
      expect(res.failed).toBe(1);
      const [row] = await sql`select status, attempts, last_error from delivery_ledger where target = 'sub_1'`;
      expect(row.attempts).toBe(i);
      expect(row.last_error).toContain('endpoint down');
      expect(row.status).toBe(i < MAX_ATTEMPTS ? 'failed' : 'exhausted');
      if (i < MAX_ATTEMPTS) {
        const [due] = await sql`select next_attempt_at > now() as future from delivery_ledger where target = 'sub_1'`;
        expect(due.future).toBe(true); // backed off into the future
      }
    }
    // exhausted rows are never picked up again
    await sql`update delivery_ledger set next_attempt_at = now() where target = 'sub_1'`;
    const res = await runFanoutOnce(sql, { webhook: failAdapter });
    expect(res).toEqual({ delivered: 0, failed: 0 });
  });

  it('a channel with no adapter is left pending (not crashed, not exhausted)', async () => {
    const res = await runFanoutOnce(sql, {});
    expect(res).toEqual({ delivered: 0, failed: 0 });
    const [row] = await sql`select status from delivery_ledger where target = 'sub_1'`;
    expect(row.status).toBe('pending');
  });

  it('an orphaned ledger row (announcement deleted) is marked exhausted and does not block the batch', async () => {
    await sql`insert into delivery_ledger (announcement_id, revision, kind, channel, target, next_attempt_at)
      values ('ann_missing', 1, 'publish', 'webhook', 'sub_orphan', now() - interval '2 days')`;
    const calls: string[] = [];
    const res = await runFanoutOnce(sql, { webhook: okAdapter(calls) });
    expect(res).toEqual({ delivered: 1, failed: 0 });
    expect(calls).toEqual(['ann_w:sub_1']);
    const [orphan] = await sql`select status, last_error, next_attempt_at > now() - interval '1 minute' as stamped from delivery_ledger where target = 'sub_orphan'`;
    expect(orphan.status).toBe('exhausted');
    expect(orphan.last_error).toBe('announcement missing');
    expect(orphan.stamped).toBe(true); // health.ts's exhausted window needs a fresh timestamp
    const [good] = await sql`select status from delivery_ledger where target = 'sub_1'`;
    expect(good.status).toBe('delivered');
  });
});
